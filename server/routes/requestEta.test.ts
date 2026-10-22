import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import EpisodeRequest from '@server/entity/EpisodeRequest';
import Media from '@server/entity/Media';
import MediaEvent, { MediaEventType } from '@server/entity/MediaEvent';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import downloadTracker from '@server/lib/downloadtracker';
import { Permission } from '@server/lib/permissions';
import { resetEtaCachesForTests } from '@server/lib/requestEta';
import { getSettings } from '@server/lib/settings';
import mediaRoutes from '@server/routes/media';
import requestRoutes from '@server/routes/request';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Request ETAs, against a fake Radarr and Sonarr and this server's own
 * history, behind the real API validator.
 */

setupTestDb();

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

// TMDB, per title: release dates by region for films, the next episode for
// series. Titles without an entry get none.
let tmdbReleases: Record<number, unknown> = {};
let tmdbNextEpisode: Record<number, unknown> = {};
Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async ({ movieId }: { movieId: number }) => ({
      id: movieId,
      title: 'T',
      overview: '',
      poster_path: null,
      release_dates: tmdbReleases[movieId] ?? { results: [] },
    });
  },
});
Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  configurable: true,
  set() {},
  get() {
    return async ({ tvId }: { tvId: number }) => ({
      id: tvId,
      name: 'T',
      seasons: [],
      external_ids: {},
      keywords: { results: [] },
      next_episode_to_air: tmdbNextEpisode[tvId] ?? null,
    });
  },
});

let radarrMovies: Record<number, unknown> = {};
let sonarrEpisodes: unknown[] = [];
const fake = http.createServer((req, res) => {
  const url = req.url ?? '';
  const movie = url.match(/^\/api\/v3\/movie\/(\d+)/);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (movie)
    return res.end(JSON.stringify(radarrMovies[Number(movie[1])] ?? {}));
  if (url.startsWith('/api/v3/episode'))
    return res.end(JSON.stringify(sonarrEpisodes));
  res.end('{}');
});
let fakePort: number;
let app: Server;
let port: number;
let actingAs: User;
let requester: User;
let other: User;
let admin: User;
let downloads: Record<number, unknown[]> = {};

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  fakePort = (fake.address() as { port: number }).port;
  Object.defineProperty(downloadTracker, 'getMovieProgress', {
    configurable: true,
    value: (_server: number, id: number) => downloads[id] ?? [],
  });
  const ex = express();
  ex.use(express.json());
  ex.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  ex.use((req, _res, next) => {
    (req as unknown as { user: User }).user = actingAs;
    next();
  });
  ex.use('/api/v1/request', requestRoutes);
  ex.use('/api/v1/media', mediaRoutes);
  app = await new Promise<Server>((resolve) => {
    const s = ex.listen(0, () => resolve(s));
  });
  port = (app.address() as { port: number }).port;
});
after(() => {
  app?.close();
  fake.close();
});

beforeEach(async () => {
  resetEtaCachesForTests();
  tmdbReleases = {};
  tmdbNextEpisode = {};
  radarrMovies = {};
  sonarrEpisodes = [];
  downloads = {};
  const server = (id: number, p: number) =>
    ({
      id,
      name: `S${id}`,
      hostname: '127.0.0.1',
      port: p,
      apiKey: 'k',
      useSsl: false,
      baseUrl: '',
      is4k: false,
      isDefault: false,
    }) as never;
  getSettings().radarr = [server(0, fakePort), server(1, 1)];
  getSettings().sonarr = [server(0, fakePort)];
  requester = await getRepository(User).save(
    new User({
      email: 'eta-r@test.local',
      plexUsername: 'Jordan',
      permissions: Permission.REQUEST,
      avatar: '',
    })
  );
  other = await getRepository(User).save(
    new User({
      email: 'eta-o@test.local',
      plexUsername: 'Allen',
      permissions: Permission.REQUEST,
      avatar: '',
    })
  );
  admin = await getRepository(User).save(
    new User({
      email: 'eta-a@test.local',
      plexUsername: 'Alex',
      permissions: Permission.ADMIN,
      avatar: '',
    })
  );
  actingAs = requester;
});

const make = async (opts: {
  tmdbId: number;
  mediaType: MediaType;
  status: MediaRequestStatus;
  mediaStatus?: MediaStatus;
  serviceId?: number | null;
  externalServiceId?: number | null;
  seasons?: SeasonRequest[];
  by?: User;
}) => {
  const media = await getRepository(Media).save(
    new Media({
      tmdbId: opts.tmdbId,
      mediaType: opts.mediaType,
      status: opts.mediaStatus ?? MediaStatus.PROCESSING,
      serviceId: opts.serviceId === undefined ? 0 : opts.serviceId,
      externalServiceId:
        opts.externalServiceId === undefined
          ? opts.tmdbId
          : opts.externalServiceId,
    })
  );
  const request = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: opts.mediaType,
      media,
      requestedBy: opts.by ?? requester,
      status: MediaRequestStatus.PENDING,
      is4k: false,
      seasons: opts.seasons,
    })
  );
  await getRepository(MediaRequest)
    .createQueryBuilder()
    .update()
    .set({ status: opts.status })
    .where('id = :id', { id: request.id })
    .execute();
  return request.id;
};

const eta = (ids: number[]) =>
  new Promise<
    Record<
      string,
      {
        stage: string;
        released?: boolean;
        releasedAs?: string;
        date?: string;
        kind?: string;
        typicalDays?: number;
        minutesLeft?: number;
        phase?: string;
      }
    >
  >((resolve, reject) => {
    http
      .get(
        {
          host: '127.0.0.1',
          port,
          path: `/api/v1/request/eta?ids=${ids.join(',')}`,
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () =>
            res.statusCode === 200
              ? resolve(JSON.parse(raw))
              : reject(new Error(`${res.statusCode} ${raw}`))
          );
        }
      )
      .on('error', reject);
  });

let seeded = 9000;
const history = async (mediaType: MediaType, days: number[]) => {
  for (const d of days) {
    const tmdbId = ++seeded;
    const start = new Date(Date.now() - 60 * DAY);
    await getRepository(MediaEvent).save([
      new MediaEvent({
        tmdbId,
        mediaType,
        type: MediaEventType.PROCESSING,
        occurredAt: start,
      }),
      new MediaEvent({
        tmdbId,
        mediaType,
        type: MediaEventType.AVAILABLE,
        occurredAt: new Date(start.getTime() + d * DAY),
      }),
    ]);
  }
};

describe('request ETAs', () => {
  it('waits on approval, and says available when it is', async () => {
    const pending = await make({
      tmdbId: 1,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.PENDING,
    });
    const done = await make({
      tmdbId: 2,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
      mediaStatus: MediaStatus.AVAILABLE,
    });
    const result = await eta([pending, done]);
    assert.deepEqual(
      [result[pending].stage, result[done].stage],
      ['awaiting_approval', 'available']
    );
  });

  it("uses the release a film's minimum availability waits for", async () => {
    radarrMovies = {
      3: {
        id: 3,
        isAvailable: false,
        hasFile: false,
        minimumAvailability: 'released',
        inCinemas: inDays(-20),
        digitalRelease: inDays(10),
        physicalRelease: inDays(30),
      },
      4: {
        id: 4,
        isAvailable: false,
        hasFile: false,
        minimumAvailability: 'inCinemas',
        inCinemas: inDays(5),
        digitalRelease: inDays(40),
      },
    };
    const digital = await make({
      tmdbId: 3,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
    });
    const cinemas = await make({
      tmdbId: 4,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
    });
    const result = await eta([digital, cinemas]);
    assert.deepEqual(
      [
        result[digital].stage,
        result[digital].kind,
        result[digital].date?.slice(0, 10),
      ],
      ['unreleased', 'digital', inDays(10).slice(0, 10)]
    );
    assert.deepEqual(
      [result[cinemas].kind, result[cinemas].date?.slice(0, 10)],
      ['cinemas', inDays(5).slice(0, 10)]
    );
  });

  it('does not call a film released just because Radarr may search for it', async () => {
    // The Pangolin: minimum availability "announced", so Radarr counts it
    // available from announcement, but it opens in cinemas in five weeks.
    radarrMovies = {
      20: {
        id: 20,
        isAvailable: true,
        hasFile: false,
        minimumAvailability: 'announced',
        inCinemas: inDays(37),
      },
      21: {
        id: 21,
        isAvailable: true,
        hasFile: false,
        minimumAvailability: 'announced',
        inCinemas: inDays(-3),
        digitalRelease: inDays(40),
      },
      22: {
        id: 22,
        isAvailable: true,
        hasFile: false,
        minimumAvailability: 'announced',
      },
    };
    const notOut = await make({
      tmdbId: 20,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
    });
    const inCinemas = await make({
      tmdbId: 21,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
    });
    const noDates = await make({
      tmdbId: 22,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
    });
    radarrMovies[23] = {
      id: 23,
      isAvailable: true,
      hasFile: false,
      minimumAvailability: 'released',
      inCinemas: inDays(-60),
      digitalRelease: inDays(-2),
    };
    const digital = await make({
      tmdbId: 23,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
    });
    assert.equal(
      (await eta([digital]))[digital].releasedAs,
      'digital',
      'out in cinemas and digitally: named digital'
    );
    const result = await eta([notOut, inCinemas, noDates]);
    assert.deepEqual(
      [
        result[notOut].stage,
        result[notOut].kind,
        result[notOut].date?.slice(0, 10),
      ],
      ['unreleased', 'cinemas', inDays(37).slice(0, 10)],
      'not out: its opening date'
    );
    assert.deepEqual(
      [
        result[inCinemas].stage,
        result[inCinemas].kind,
        result[inCinemas].date?.slice(0, 10),
      ],
      ['unreleased', 'digital', inDays(40).slice(0, 10)],
      'in cinemas, digital ahead: the digital date, though Radarr may search'
    );
    assert.deepEqual(
      [result[noDates].stage, result[noDates].released],
      ['searching', false],
      'no dates: searching, not claimed released'
    );
  });

  it('says how long requests usually take here, once there is enough history', async () => {
    radarrMovies = {
      5: {
        id: 5,
        isAvailable: true,
        hasFile: false,
        minimumAvailability: 'released',
        digitalRelease: inDays(-3),
      },
    };
    const id = await make({
      tmdbId: 5,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
    });

    await history(MediaType.MOVIE, [1, 1, 2]);
    assert.deepEqual(
      await eta([id]),
      { [id]: { stage: 'searching', releasedAs: 'digital' } },
      'three past requests: too few to say'
    );

    resetEtaCachesForTests();
    await history(MediaType.MOVIE, [2, 3, 30]);
    const result = await eta([id]);
    assert.equal(result[id].stage, 'searching');
    assert.equal(
      result[id].typicalDays,
      2,
      '80% within 2 days; the 30-day wait for a release left out'
    );
  });

  it('counts only the episodes the request asked for', async () => {
    sonarrEpisodes = [
      {
        seasonNumber: 1,
        episodeNumber: 1,
        monitored: true,
        hasFile: false,
        airDateUtc: inDays(-100),
      },
      {
        seasonNumber: 1,
        episodeNumber: 5,
        monitored: true,
        hasFile: false,
        airDateUtc: inDays(3),
      },
      {
        seasonNumber: 1,
        episodeNumber: 6,
        monitored: true,
        hasFile: false,
        airDateUtc: inDays(10),
      },
    ];
    const twoEpisodes = await make({
      tmdbId: 6,
      mediaType: MediaType.TV,
      status: MediaRequestStatus.APPROVED,
      seasons: [
        new SeasonRequest({
          seasonNumber: 1,
          status: MediaRequestStatus.APPROVED,
          episodes: [5, 6].map(
            (episodeNumber) => new EpisodeRequest({ episodeNumber })
          ),
        }),
      ],
    });
    const wholeSeason = await make({
      tmdbId: 7,
      mediaType: MediaType.TV,
      status: MediaRequestStatus.APPROVED,
      seasons: [
        new SeasonRequest({
          seasonNumber: 1,
          status: MediaRequestStatus.APPROVED,
        }),
      ],
    });
    const result = await eta([twoEpisodes, wholeSeason]);
    assert.deepEqual(
      [
        result[twoEpisodes].stage,
        result[twoEpisodes].kind,
        result[twoEpisodes].date?.slice(0, 10),
      ],
      ['unreleased', 'airs', inDays(3).slice(0, 10)],
      'the aired episode 1 was not asked for'
    );
    assert.equal(
      result[wholeSeason].releasedAs,
      'aired',
      'searching, having aired'
    );
    assert.equal(
      result[wholeSeason].stage,
      'searching',
      'the whole season includes aired episode 1'
    );
  });

  it('says how long a download has left', async () => {
    downloads = {
      8: [{ estimatedCompletionTime: new Date(Date.now() + 20 * 60000) }],
    };
    const id = await make({
      tmdbId: 8,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
    });
    const result = await eta([id]);
    assert.equal(result[id].stage, 'downloading');
    assert.ok(Math.abs(result[id].minutesLeft! - 20) <= 1);
  });

  it('waits for the last part still downloading, not the first', async () => {
    downloads = {
      8: [
        {
          stage: 'downloading',
          estimatedCompletionTime: new Date(Date.now() + 5 * 60000),
        },
        {
          stage: 'downloading',
          estimatedCompletionTime: new Date(Date.now() + 40 * 60000),
        },
        { stage: 'importing' },
      ],
    };
    const id = await make({
      tmdbId: 8,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
    });
    const result = await eta([id]);
    assert.ok(Math.abs(result[id].minutesLeft! - 40) <= 1);
    assert.equal(result[id].phase, undefined);
  });

  it('says why there is no time left while nothing is moving', async () => {
    const cases: [string[], string | undefined][] = [
      [['waiting'], 'waiting'],
      [['stalled'], 'stalled'],
      [['waiting', 'stalled'], 'stalled'],
      [['stalled', 'downloading'], undefined],
      [['queued'], 'queued'],
      [['queued:metadata'], 'details'],
      [['queued', 'queued:metadata'], 'details'],
      [['paused'], 'paused'],
      [['paused', 'queued'], 'queued'],
      [['queued', 'stalled'], 'stalled'],
      [['waiting', 'paused'], 'paused'],
      [['paused', 'downloading'], undefined],
    ];
    for (const [stages, phase] of cases) {
      downloads = {
        8: stages.map((named) => ({
          stage: named.split(':')[0],
          step: named.split(':')[1],
          estimatedCompletionTime:
            named === 'downloading'
              ? new Date(Date.now() + 10 * 60000)
              : undefined,
        })),
      };
      const id = await make({
        tmdbId: 8,
        mediaType: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
      });
      const result = await eta([id]);
      assert.deepEqual(
        [result[id].stage, result[id].phase, result[id].minutesLeft],
        ['downloading', phase, undefined],
        stages.join(', ')
      );
    }
  });

  it('says what happens once everything has downloaded', async () => {
    const cases: [string[], string][] = [
      [['finishing'], 'finishing'],
      [['importing', 'finishing'], 'finishing'],
      [['importing'], 'importing'],
      [['importing', 'needsAttention'], 'held'],
      [['failed'], 'retrying'],
      [['importing', 'failed'], 'retrying'],
      [['failed', 'needsAttention'], 'held'],
    ];
    for (const [stages, phase] of cases) {
      downloads = {
        8: stages.map((stage) => ({
          stage,
          // What Radarr and Sonarr report once nothing is left: now.
          estimatedCompletionTime: new Date(),
        })),
      };
      const id = await make({
        tmdbId: 8,
        mediaType: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
      });
      const result = await eta([id]);
      assert.deepEqual(
        [result[id].stage, result[id].phase, result[id].minutesLeft],
        ['downloading', phase, undefined],
        stages.join(', ')
      );
    }
  });

  it('gives no estimate rather than a wrong one', async () => {
    const unreachable = await make({
      tmdbId: 9,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
      serviceId: 1,
    });
    const unsent = await make({
      tmdbId: 10,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
      serviceId: null,
      externalServiceId: null,
    });
    const result = await eta([unreachable, unsent]);
    assert.deepEqual(
      [result[unreachable].stage, result[unsent].stage],
      ['unknown', 'unknown']
    );
  });

  it("shows people only their own requests, and admins everyone's", async () => {
    const mine = await make({
      tmdbId: 11,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.PENDING,
    });
    const theirs = await make({
      tmdbId: 12,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.PENDING,
      by: other,
    });
    assert.deepEqual(Object.keys(await eta([mine, theirs])), [String(mine)]);
    actingAs = admin;
    assert.deepEqual(
      Object.keys(await eta([mine, theirs])).sort(),
      [String(mine), String(theirs)].sort()
    );
  });
});

describe('release dates as the title page shows them', () => {
  const us = (entries: [number, number][], region = 'US') => ({
    results: [
      {
        iso_3166_1: region,
        release_dates: entries.map(([type, days]) => ({
          type,
          release_date: inDays(days),
        })),
      },
    ],
  });

  it('shows the digital date for a film Radarr has no link for', async () => {
    // Vesperline: Out of the Hollow — in cinemas already, digital ahead, and
    // Radarr cannot be asked about it.
    tmdbReleases[31] = us([
      [3, -33],
      [4, 13],
    ]);
    const id = await make({
      tmdbId: 31,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
      serviceId: null,
      externalServiceId: null,
    });
    const result = (await eta([id]))[id];
    assert.deepEqual(
      [result.stage, result.kind, result.date?.slice(0, 10)],
      ['unreleased', 'digital', inDays(13).slice(0, 10)]
    );
  });

  it('does not claim a film is being searched for when Radarr does not have it', async () => {
    tmdbReleases[32] = us([
      [3, -60],
      [4, -5],
    ]);
    const id = await make({
      tmdbId: 32,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
      serviceId: null,
      externalServiceId: null,
    });
    assert.equal((await eta([id]))[id].stage, 'unknown');
  });

  it('shows the digital date with minimum availability "announced", as on the live server', async () => {
    // The live setup: default Radarr on "announced", a film it has no link
    // for, in cinemas already, digital ahead — Vesperline: Out of the Hollow.
    getSettings().radarr = [
      {
        id: 0,
        name: 'Radarr',
        hostname: '127.0.0.1',
        port: fakePort,
        apiKey: 'k',
        useSsl: false,
        baseUrl: '',
        is4k: false,
        isDefault: true,
        minimumAvailability: 'announced',
      } as never,
    ];
    tmdbReleases[36] = us([
      [3, -33],
      [4, 13],
    ]);
    const id = await make({
      tmdbId: 36,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
      serviceId: null,
      externalServiceId: null,
    });
    const result = (await eta([id]))[id];
    assert.deepEqual(
      [result.stage, result.kind, result.date?.slice(0, 10)],
      ['unreleased', 'digital', inDays(13).slice(0, 10)]
    );
  });

  it('says "In Cinemas - Searching" when no digital date is known yet', async () => {
    radarrMovies[37] = {
      id: 37,
      isAvailable: true,
      hasFile: false,
      minimumAvailability: 'announced',
      inCinemas: inDays(-10),
    };
    const id = await make({
      tmdbId: 37,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
    });
    const result = (await eta([id]))[id];
    assert.deepEqual(
      [result.stage, result.releasedAs],
      ['searching', 'cinemas']
    );
  });

  it("prefers the page's dates to Radarr's", async () => {
    tmdbReleases[33] = us([[4, 10]]);
    radarrMovies[33] = {
      id: 33,
      isAvailable: false,
      hasFile: false,
      minimumAvailability: 'released',
      digitalRelease: inDays(50),
    };
    const id = await make({
      tmdbId: 33,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
    });
    assert.equal(
      (await eta([id]))[id].date?.slice(0, 10),
      inDays(10).slice(0, 10)
    );
  });

  it("uses the viewer's region", async () => {
    tmdbReleases[34] = {
      results: [...us([[4, 10]]).results, ...us([[4, 25]], 'GB').results],
    };
    const id = await make({
      tmdbId: 34,
      mediaType: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
      serviceId: null,
      externalServiceId: null,
    });
    assert.equal(
      (await eta([id]))[id].date?.slice(0, 10),
      inDays(10).slice(0, 10),
      'no region set: the US'
    );
    requester.settings = { discoverRegion: 'GB' } as never;
    assert.equal(
      (await eta([id]))[id].date?.slice(0, 10),
      inDays(25).slice(0, 10),
      'set to GB: the GB date'
    );
  });

  it("shows a series' next episode when Sonarr cannot be asked", async () => {
    tmdbNextEpisode[35] = {
      air_date: inDays(6).slice(0, 10),
      season_number: 2,
      episode_number: 1,
    };
    const asked = await make({
      tmdbId: 35,
      mediaType: MediaType.TV,
      status: MediaRequestStatus.APPROVED,
      serviceId: null,
      externalServiceId: null,
      seasons: [
        new SeasonRequest({
          seasonNumber: 2,
          status: MediaRequestStatus.APPROVED,
        }),
      ],
    });
    const other = await make({
      tmdbId: 35,
      mediaType: MediaType.TV,
      status: MediaRequestStatus.APPROVED,
      serviceId: null,
      externalServiceId: null,
      seasons: [
        new SeasonRequest({
          seasonNumber: 1,
          status: MediaRequestStatus.APPROVED,
        }),
      ],
    });
    const result = await eta([asked, other]);
    assert.deepEqual(
      [
        result[asked].stage,
        result[asked].kind,
        result[asked].date?.slice(0, 10),
      ],
      ['unreleased', 'airs', inDays(6).slice(0, 10)]
    );
    assert.equal(
      result[other].stage,
      'unknown',
      'season 1 was asked for, not season 2'
    );
  });
});

describe('a title being processed with no request', () => {
  const titleEta = (mediaId: number, is4k = false) =>
    new Promise<{
      stage: string;
      kind?: string;
      date?: string;
      releasedAs?: string;
    }>((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port,
            path: `/api/v1/media/${mediaId}/eta${is4k ? '?is4k=true' : ''}`,
          },
          (res) => {
            let raw = '';
            res.on('data', (c) => (raw += c));
            res.on('end', () =>
              res.statusCode === 200
                ? resolve(JSON.parse(raw))
                : reject(new Error(`${res.statusCode} ${raw}`))
            );
          }
        )
        .on('error', reject);
    });
  const us = (entries: [number, number][]) => ({
    results: [
      {
        iso_3166_1: 'US',
        release_dates: entries.map(([type, days]) => ({
          type,
          release_date: inDays(days),
        })),
      },
    ],
  });

  it('estimates Vesperline: in Radarr on "announced", no request, in cinemas, digital ahead', async () => {
    tmdbReleases[1382706] = us([
      [3, -33],
      [4, 13],
    ]);
    radarrMovies[2175] = {
      id: 2175,
      isAvailable: true,
      hasFile: false,
      minimumAvailability: 'announced',
    };
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 1382706,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 2175,
      })
    );
    const result = await titleEta(media.id);
    assert.deepEqual(
      [result.stage, result.kind, result.date?.slice(0, 10)],
      ['unreleased', 'digital', inDays(13).slice(0, 10)]
    );
  });

  it('counts every season of a series with no request', async () => {
    sonarrEpisodes = [
      {
        seasonNumber: 1,
        episodeNumber: 1,
        monitored: true,
        hasFile: true,
        airDateUtc: inDays(-400),
      },
      {
        seasonNumber: 3,
        episodeNumber: 2,
        monitored: true,
        hasFile: false,
        airDateUtc: inDays(-2),
      },
    ];
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 41,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 41,
      })
    );
    const result = await titleEta(media.id);
    assert.deepEqual(
      [result.stage, result.releasedAs],
      ['searching', 'aired'],
      'season 3 counts, though no request named it'
    );
  });

  it('reads the 4K side when asked', async () => {
    // Only the 4K side is in Radarr: a misread flag would give no estimate.
    tmdbReleases[42] = us([
      [3, -60],
      [4, -5],
    ]);
    radarrMovies[4242] = {
      id: 4242,
      isAvailable: true,
      hasFile: false,
      minimumAvailability: 'released',
    };
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 42,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.PROCESSING,
        serviceId4k: 0,
        externalServiceId4k: 4242,
      })
    );
    assert.deepEqual(
      [
        (await titleEta(media.id, true)).stage,
        (await titleEta(media.id, true)).releasedAs,
      ],
      ['searching', 'digital']
    );
    assert.equal(
      (await titleEta(media.id)).stage,
      'unknown',
      'the non-4K side is not in Radarr'
    );
  });
});

describe('the approval notification', () => {
  const movieRequest = { type: MediaType.MOVIE, is4k: false } as MediaRequest;
  const releases = (entries: [number, number][]) => ({
    release_dates: {
      results: [
        {
          iso_3166_1: 'US',
          release_dates: entries.map(([type, days]) => ({
            type,
            release_date: inDays(days),
          })),
        },
      ],
    },
  });
  const md = (days: number) =>
    new Date(Date.now() + days * DAY).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year:
        new Date(Date.now() + days * DAY).getUTCFullYear() ===
        new Date().getUTCFullYear()
          ? undefined
          : 'numeric',
    });

  it('names the release the default Radarr waits for', async () => {
    const { expectedOnApproval } = await import('@server/lib/requestEta');
    getSettings().radarr = [
      {
        id: 0,
        isDefault: true,
        is4k: false,
        minimumAvailability: 'released',
      } as never,
    ];
    assert.equal(
      expectedOnApproval(
        movieRequest,
        releases([
          [3, 5],
          [4, 20],
          [5, 40],
        ])
      ),
      `Digital release expected ${md(20)}`,
      'not the cinema date'
    );
    assert.equal(
      expectedOnApproval(
        movieRequest,
        releases([
          [3, 5],
          [5, 15],
          [4, 30],
        ])
      ),
      `Physical release expected ${md(15)}`,
      'whichever comes first'
    );
    assert.equal(
      expectedOnApproval(
        movieRequest,
        releases([
          [3, -30],
          [4, -2],
        ])
      ),
      undefined,
      'already out: nothing to add'
    );

    getSettings().radarr = [
      {
        id: 0,
        isDefault: true,
        is4k: false,
        minimumAvailability: 'inCinemas',
      } as never,
    ];
    assert.equal(
      expectedOnApproval(
        movieRequest,
        releases([
          [3, 5],
          [4, 20],
        ])
      ),
      `In cinemas ${md(5)}`
    );
  });

  it('writes a release date as the date it is, whatever the time zone', async () => {
    // TMDB gives calendar dates at midnight UTC. Run with TZ=America/Los_Angeles,
    // local formatting would write Oct 30 as Oct 29.
    const { expectedOnApproval } = await import('@server/lib/requestEta');
    getSettings().radarr = [
      {
        id: 0,
        isDefault: true,
        is4k: false,
        minimumAvailability: 'inCinemas',
      } as never,
    ];
    const film = {
      release_dates: {
        results: [
          {
            iso_3166_1: 'US',
            release_dates: [
              { type: 3, release_date: '2099-10-30T00:00:00.000Z' },
            ],
          },
        ],
      },
    };
    assert.equal(
      expectedOnApproval(movieRequest, film),
      'In cinemas Oct 30, 2099'
    );
  });

  it("names a series' next episode only if the request asked for it", async () => {
    const { expectedOnApproval } = await import('@server/lib/requestEta');
    const next = {
      next_episode_to_air: {
        air_date: inDays(4),
        season_number: 2,
        episode_number: 3,
      },
    };
    const req = (seasons: SeasonRequest[]) =>
      ({ type: MediaType.TV, is4k: false, seasons }) as MediaRequest;
    assert.equal(
      expectedOnApproval(req([new SeasonRequest({ seasonNumber: 2 })]), next),
      `Next requested episode airs ${md(4)}`
    );
    assert.equal(
      expectedOnApproval(
        req([
          new SeasonRequest({
            seasonNumber: 2,
            episodes: [new EpisodeRequest({ episodeNumber: 3 })],
          }),
        ]),
        next
      ),
      `Next requested episode airs ${md(4)}`
    );
    assert.equal(
      expectedOnApproval(
        req([
          new SeasonRequest({
            seasonNumber: 2,
            episodes: [new EpisodeRequest({ episodeNumber: 9 })],
          }),
        ]),
        next
      ),
      undefined
    );
    assert.equal(
      expectedOnApproval(req([new SeasonRequest({ seasonNumber: 1 })]), next),
      undefined
    );
  });

  it('carries it on an approval, and says it in the push message', async () => {
    const { default: notificationManager, Notification } =
      await import('@server/lib/notifications');
    const sent: { type: number; extra?: { name: string; value: string }[] }[] =
      [];
    Object.defineProperty(notificationManager, 'sendNotification', {
      configurable: true,
      value: (
        type: number,
        payload: { extra?: { name: string; value: string }[] }
      ) => sent.push({ type, extra: payload.extra }),
    });
    tmdbReleases[501] = releases([[4, 20]]).release_dates;
    getSettings().radarr = [
      {
        id: 0,
        isDefault: true,
        is4k: false,
        minimumAvailability: 'released',
      } as never,
    ];

    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 501,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PENDING,
      })
    );
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: {
        id: await make({
          tmdbId: 502,
          mediaType: MediaType.MOVIE,
          status: MediaRequestStatus.APPROVED,
        }),
      },
      relations: { requestedBy: true },
    });
    sent.length = 0;
    await MediaRequest.sendNotification(
      request,
      media,
      Notification.MEDIA_APPROVED
    );
    await MediaRequest.sendNotification(
      request,
      media,
      Notification.MEDIA_DECLINED
    );
    assert.deepEqual(
      sent.map((s) => [
        s.type,
        s.extra?.find((e) => e.name === 'Expected')?.value,
      ]),
      [
        [Notification.MEDIA_APPROVED, `Digital release expected ${md(20)}`],
        [Notification.MEDIA_DECLINED, undefined],
      ]
    );

    // The server loads its translations at startup.
    (await import('@server/i18n')).initI18n();
    const { default: WebPushAgent } =
      await import('@server/lib/notifications/agents/webpush');
    const agent = new WebPushAgent() as unknown as {
      getNotificationPayload: (
        type: number,
        payload: unknown
      ) => { message: string };
    };
    const push = agent.getNotificationPayload(Notification.MEDIA_APPROVED, {
      request,
      media,
      subject: 'Film',
      extra: sent[0].extra,
    });
    assert.match(
      push.message,
      new RegExp(`approved\\. Digital release expected ${md(20)}\\.$`)
    );
  });
});
