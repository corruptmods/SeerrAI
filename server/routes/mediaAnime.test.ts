import TheMovieDb from '@server/api/themoviedb';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import mediaRoutes from '@server/routes/media';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * A title's anime setting on its manage panel, against a fake Sonarr and
 * Radarr, behind the real API validator.
 */

setupTestDb();

const ANIMATION = { id: 16, name: 'Animation' };
// TMDB as the scan sees it: Yorumaki is listed as American and English.
const YORUMAKI = 90001;
const OSHI_NO_KO = 90002;
const SPIRITED_AWAY = 90003;
const shows: Record<number, object> = {
  [YORUMAKI]: {
    id: YORUMAKI,
    genres: [ANIMATION],
    original_language: 'en',
    origin_country: ['US'],
    keywords: { results: [] },
  },
  [OSHI_NO_KO]: {
    id: OSHI_NO_KO,
    genres: [ANIMATION],
    original_language: 'ja',
    origin_country: ['JP'],
    keywords: { results: [] },
  },
};
const movies: Record<number, object> = {
  [SPIRITED_AWAY]: {
    id: SPIRITED_AWAY,
    genres: [ANIMATION],
    original_language: 'ja',
    production_countries: [{ iso_3166_1: 'JP' }],
    keywords: { keywords: [] },
  },
};

// The plain lookups too: saving a request sends a notification, which
// names the title.
for (const [method, table, key] of [
  ['getTvShowForScan', shows, 'tvId'],
  ['getMovieForScan', movies, 'movieId'],
  ['getTvShow', shows, 'tvId'],
  ['getMovie', movies, 'movieId'],
] as const) {
  Object.defineProperty(TheMovieDb.prototype, method, {
    get() {
      return async (args: Record<string, number>) => {
        const found = table[args[key]];
        if (!found) {
          throw new Error('not found');
        }
        return found;
      };
    },
    set() {},
    configurable: true,
  });
}

// What the fake Sonarr and Radarr hold, and the edits they were sent.
let series: Record<number, Record<string, unknown>> = {};
let radarrMovies: Record<number, Record<string, unknown>> = {};
let edits: { url: string; body: Record<string, unknown> }[] = [];
let failEdits = false;
const profiles = [
  { id: 1, name: 'HD-1080p' },
  { id: 6, name: '1080p Efficient' },
  { id: 9, name: 'Anime 1080p (movies)' },
  { id: 13, name: 'Anime 1080p' },
];

const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url ?? '', 'http://x').pathname;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.endsWith('/qualityProfile')) {
      return send(200, profiles);
    }
    if (req.method === 'PUT' && url.endsWith('/editor')) {
      if (failEdits) {
        return send(500, { message: 'disk full' });
      }
      const body = JSON.parse(raw);
      edits.push({ url, body });
      const ids: number[] = body.seriesIds ?? body.movieIds;
      const store = body.seriesIds ? series : radarrMovies;
      for (const id of ids) {
        const item = store[id];
        if (body.rootFolderPath) {
          item.path = `${body.rootFolderPath}/${item.folder}`;
        }
        if (body.qualityProfileId) {
          item.qualityProfileId = body.qualityProfileId;
        }
        if (body.seriesType) {
          item.seriesType = body.seriesType;
        }
      }
      return send(202, []);
    }
    const seriesMatch = url.match(/\/series\/(\d+)$/);
    if (seriesMatch && series[Number(seriesMatch[1])]) {
      return send(200, series[Number(seriesMatch[1])]);
    }
    const movieMatch = url.match(/\/movie\/(\d+)$/);
    if (movieMatch && radarrMovies[Number(movieMatch[1])]) {
      return send(200, radarrMovies[Number(movieMatch[1])]);
    }
    send(404, { message: 'NotFound' });
  });
});

let app: Server;
let port: number;
let actingAs: User;
let admin: User;
let manager: User;

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
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
  ex.use('/api/v1/media', mediaRoutes);
  ex.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );
  app = await new Promise<Server>((resolve) => {
    const s = ex.listen(0, () => resolve(s));
  });
  port = (app.address() as { port: number }).port;
});
after(() => {
  app?.close();
  fake.close();
});

const server = {
  hostname: '127.0.0.1',
  apiKey: 'k',
  useSsl: false,
  baseUrl: '',
  is4k: false,
  isDefault: true,
  tags: [],
  syncEnabled: true,
  preventSearch: false,
};

beforeEach(async () => {
  edits = [];
  failEdits = false;
  const fakePort = (fake.address() as { port: number }).port;
  getSettings().sonarr = [
    {
      ...server,
      id: 0,
      name: 'Sonarr',
      port: fakePort,
      activeDirectory: '/tv',
      activeProfileId: 1,
      activeAnimeDirectory: '/anime',
      activeAnimeProfileId: 13,
      seriesType: 'standard',
      animeSeriesType: 'anime',
    } as unknown as SonarrSettings,
  ];
  getSettings().radarr = [
    {
      ...server,
      id: 0,
      name: 'Radarr',
      port: fakePort,
      activeDirectory: '/movies',
      activeProfileId: 6,
      activeAnimeDirectory: '/anime-movies',
      activeAnimeProfileId: 9,
    } as unknown as RadarrSettings,
  ];
  series = {
    654: {
      id: 654,
      folder: 'Yorumaki',
      path: '/tv/Yorumaki',
      qualityProfileId: 1,
      seriesType: 'standard',
    },
    700: {
      id: 700,
      folder: 'Yume no Tane',
      path: '/anime/Yume no Tane',
      qualityProfileId: 13,
      seriesType: 'anime',
    },
  };
  radarrMovies = {
    41: {
      id: 41,
      folder: 'Lantern Drift (2001)',
      path: '/anime-movies/Lantern Drift (2001)',
      qualityProfileId: 9,
    },
  };
  admin = await getRepository(User).save(
    new User({
      email: 'anime-admin@test.local',
      permissions: Permission.ADMIN,
      avatar: '/a.png',
    })
  );
  manager = await getRepository(User).save(
    new User({
      email: 'anime-manager@test.local',
      permissions: Permission.MANAGE_REQUESTS,
      avatar: '/m.png',
    })
  );
  actingAs = admin;
});

const linked = (
  mediaType: MediaType,
  tmdbId: number,
  externalServiceId: number
) =>
  getRepository(Media).save(
    new Media({
      mediaType,
      tmdbId,
      serviceId: 0,
      externalServiceId,
    })
  );

const call = async (method: 'GET' | 'PUT', mediaId: number, body?: unknown) => {
  const res = await fetch(
    `http://127.0.0.1:${port}/api/v1/media/${mediaId}/anime`,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }
  );
  return { status: res.status, body: await res.json() };
};

describe('GET /media/:id/anime', () => {
  it('says what Seerr decided and what would put the title where it belongs', async () => {
    const media = await linked(MediaType.TV, YORUMAKI, 654);
    const res = await call('GET', media.id);
    assert.equal(res.status, 200);
    assert.deepEqual(
      [
        res.body.animeSetting,
        res.body.detected,
        res.body.anime,
        res.body.decidedBy,
        res.body.automatic,
      ],
      [null, false, false, 'detection', false]
    );
    assert.equal(res.body.servers.length, 1);
    const [sonarr] = res.body.servers;
    assert.deepEqual(
      [
        sonarr.serverName,
        sonarr.path,
        sonarr.qualityProfile,
        sonarr.seriesType,
      ],
      ['Sonarr', '/tv/Yorumaki', 'HD-1080p', 'standard']
    );
    assert.deepEqual(sonarr.ifNotAnime, {});
    assert.deepEqual(sonarr.ifAnime, {
      rootFolderPath: '/anime',
      qualityProfileId: 13,
      qualityProfileName: 'Anime 1080p',
      seriesType: 'anime',
    });
  });

  it('lists no servers for a title not in Sonarr or Radarr yet', async () => {
    const media = await getRepository(Media).save(
      new Media({ mediaType: MediaType.TV, tmdbId: OSHI_NO_KO })
    );
    const res = await call('GET', media.id);
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.anime, res.body.servers], [true, []]);
  });

  it('is for admins only', async () => {
    const media = await linked(MediaType.TV, YORUMAKI, 654);
    actingAs = manager;
    assert.equal((await call('GET', media.id)).status, 403);
    assert.equal(
      (await call('PUT', media.id, { animeSetting: true })).status,
      403
    );
  });

  it('answers 404 for media that does not exist', async () => {
    assert.equal((await call('GET', 999999)).status, 404);
  });
});

describe('PUT /media/:id/anime', () => {
  it('sets a series as anime and moves it in Sonarr to match', async () => {
    const media = await linked(MediaType.TV, YORUMAKI, 654);
    const res = await call('PUT', media.id, { animeSetting: true });
    assert.equal(res.status, 200);
    assert.deepEqual(edits, [
      {
        url: '/api/v3/series/editor',
        body: {
          seriesIds: [654],
          rootFolderPath: '/anime',
          qualityProfileId: 13,
          seriesType: 'anime',
          moveFiles: true,
        },
      },
    ]);
    assert.deepEqual(
      [res.body.animeSetting, res.body.anime, res.body.decidedBy],
      [true, true, 'title']
    );
    assert.deepEqual(res.body.applied, [
      {
        serverName: 'Sonarr',
        is4k: false,
        changes: {
          rootFolderPath: '/anime',
          qualityProfileId: 13,
          seriesType: 'anime',
        },
      },
    ]);
    // Read again after the move, it is where it belongs.
    assert.equal(res.body.servers[0].path, '/anime/Yorumaki');
    assert.deepEqual(res.body.servers[0].ifAnime, {});
    const saved = await getRepository(Media).findOneByOrFail({ id: media.id });
    assert.equal(saved.animeSetting, true);
  });

  it('puts a series back when set to automatic, and leaves alone what is right', async () => {
    const media = await linked(MediaType.TV, YORUMAKI, 654);
    await call('PUT', media.id, { animeSetting: true });
    edits = [];
    const res = await call('PUT', media.id, { animeSetting: null });
    assert.equal(res.status, 200);
    assert.deepEqual(edits[0].body, {
      seriesIds: [654],
      rootFolderPath: '/tv',
      qualityProfileId: 1,
      seriesType: 'standard',
      moveFiles: true,
    });
    edits = [];
    const again = await call('PUT', media.id, { animeSetting: null });
    assert.deepEqual([edits, again.body.applied], [[], []]);
  });

  it('only changes what is wrong, and does not move files it leaves in place', async () => {
    series[654].qualityProfileId = 13;
    series[654].path = '/anime/Yorumaki';
    const media = await linked(MediaType.TV, YORUMAKI, 654);
    await call('PUT', media.id, { animeSetting: true });
    assert.deepEqual(edits[0].body, {
      seriesIds: [654],
      seriesType: 'anime',
      moveFiles: false,
    });
  });

  it('sets a movie as not anime and moves it in Radarr to match', async () => {
    const media = await linked(MediaType.MOVIE, SPIRITED_AWAY, 41);
    const res = await call('PUT', media.id, { animeSetting: false });
    assert.equal(res.status, 200);
    assert.deepEqual(edits, [
      {
        url: '/api/v3/movie/editor',
        body: {
          movieIds: [41],
          rootFolderPath: '/movies',
          qualityProfileId: 6,
          moveFiles: true,
        },
      },
    ]);
    assert.equal(res.body.servers[0].path, '/movies/Lantern Drift (2001)');
  });

  it('says when Sonarr could not be changed, and keeps the setting', async () => {
    const media = await linked(MediaType.TV, YORUMAKI, 654);
    failEdits = true;
    const res = await call('PUT', media.id, { animeSetting: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.applied.length, 1);
    assert.match(res.body.applied[0].error, /Failed to edit series/);
    assert.equal(res.body.servers[0].path, '/tv/Yorumaki');
    const saved = await getRepository(Media).findOneByOrFail({ id: media.id });
    assert.equal(saved.animeSetting, true);
  });

  it('replaces anime or not chosen on its requests that disagrees', async () => {
    const media = await linked(MediaType.TV, OSHI_NO_KO, 700);
    const requestedBy = await getRepository(User).findOneByOrFail({
      email: 'friend@seerr.dev',
    });
    // Pending: an approved one would be sent on to Sonarr when saved, which
    // is not what is tested here.
    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy,
        is4k: false,
        seriesType: 'standard',
      })
    );
    let res = await call('GET', media.id);
    assert.deepEqual(
      [res.body.anime, res.body.decidedBy, res.body.automatic],
      [false, 'request', false]
    );
    res = await call('PUT', media.id, { animeSetting: true });
    assert.deepEqual(
      [res.body.anime, res.body.decidedBy, res.body.automatic],
      [true, 'title', true]
    );
    assert.deepEqual(edits, []);
    const [cleared] = await getRepository(MediaRequest).find({
      where: { media: { id: media.id } },
    });
    assert.equal(cleared.seriesType, null);
  });

  it('refuses a setting that is not true, false or null', async () => {
    const media = await linked(MediaType.TV, YORUMAKI, 654);
    assert.equal(
      (await call('PUT', media.id, { animeSetting: 'yes' })).status,
      400
    );
    assert.equal((await call('PUT', media.id, {})).status, 400);
  });
});
