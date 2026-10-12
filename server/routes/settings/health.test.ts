import DelugeAPI from '@server/api/downloadclients/deluge';
import NzbgetAPI from '@server/api/downloadclients/nzbget';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import Media from '@server/entity/Media';
import MediaEvent from '@server/entity/MediaEvent';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import plexMatchCheck from '@server/lib/plexMatchCheck';
import type { RadarrSettings } from '@server/lib/settings';
import { BACKFILL_DEFAULTS, getSettings } from '@server/lib/settings';
import mediaRoutes from '@server/routes/media';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

/*
 * The admin health page's checks, against a real database and real HTTP:
 * services that answer and one that does not, and requests, titles and users
 * in each problem state alongside ones that must not be flagged.
 */

setupTestDb();

const HOUR = 60 * 60 * 1000;
const GB = 1024 ** 3;
const DAY = 24 * HOUR;

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async ({ movieId }: { movieId: number }) => ({
      id: movieId,
      title: `Movie ${movieId}`,
    });
  },
});
Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  configurable: true,
  set() {},
  get() {
    return async ({ tvId }: { tvId: number }) => ({
      id: tvId,
      name: `Show ${tvId}`,
    });
  },
});

// A service that answers the status calls Seerr makes, and Radarr's and
// Sonarr's catalogues as their APIs return them.
let radarrMovies: unknown[] = [];
let sonarrSeries: unknown[] = [];
let sonarrEpisodes: unknown[] = [];
let commands: { name: string; episodeIds?: number[]; movieIds?: number[] }[] =
  [];
// What the fake Radarr says on its health page, and its disks.
let arrHealth: unknown[] = [];
let rootFolders: unknown[] = [];
// The fake Prowlarr's indexers and their failures.
let indexers: unknown[] = [];
let indexerStatus: unknown[] = [];
// The fake Bazarr's status page and providers.
let bazarrHealth: unknown[] = [];
let bazarrProviders: unknown[] = [];
const fake = http.createServer((req, res) => {
  const url = req.url ?? '';
  if (req.method === 'POST' && url.startsWith('/api/v3/command')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      commands.push(JSON.parse(raw));
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1 }));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  const answers: [string, unknown][] = [
    ['/api/v3/health', arrHealth],
    ['/api/v3/rootfolder', rootFolders],
    ['/api/v1/health', []],
    ['/api/v1/indexerstatus', indexerStatus],
    ['/api/v1/indexer', indexers],
    ['/api/system/status', { data: { bazarr_version: '1.5.3' } }],
    ['/api/system/health', { data: bazarrHealth }],
    ['/api/providers', { data: bazarrProviders }],
  ];
  const answer = answers.find(([prefix]) => url.startsWith(prefix));
  if (answer) {
    res.end(JSON.stringify(answer[1]));
    return;
  }
  if (url.startsWith('/api/v3/episode')) {
    res.end(JSON.stringify(sonarrEpisodes));
    return;
  }
  res.end(
    url.startsWith('/api/settings/version')
      ? JSON.stringify('2.20.0')
      : url.startsWith('/api/v3/movie')
        ? JSON.stringify(radarrMovies)
        : url.startsWith('/api/v3/series')
          ? JSON.stringify(sonarrSeries)
          : JSON.stringify({ version: '5.0.0' })
  );
});
let fakePort: number;
let actingAs: User | undefined;
let app: Server;
let port: number;

type Check = {
  id: string;
  group: string;
  name?: string;
  status: string;
  count: number;
  detail?: string;
  items: { title: string; detail?: string; href?: string }[];
};
const health = () =>
  new Promise<Check[]>((resolve, reject) => {
    http
      .get(
        { host: '127.0.0.1', port, path: '/api/v1/settings/health' },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => resolve(JSON.parse(raw).checks));
        }
      )
      .on('error', reject);
  });
const byId = (checks: Check[], id: string) => checks.find((c) => c.id === id)!;

const radarr = (id: number, name: string, portNumber: number): RadarrSettings =>
  ({
    id,
    name,
    hostname: '127.0.0.1',
    port: portNumber,
    apiKey: 'k',
    useSsl: false,
    baseUrl: '',
    activeProfileId: 1,
    activeProfileName: 'Any',
    activeDirectory: '/m',
    is4k: false,
    isDefault: false,
    minimumAvailability: 'released',
    tags: [],
    syncEnabled: false,
    preventSearch: false,
    tagRequests: false,
    overrideRule: [],
  }) as unknown as RadarrSettings;

before(async () => {
  // The match check's last report is a file other tests may have left.
  mock.method(plexMatchCheck, 'lastReport', async () => ({
    finishedAt: null,
    running: false,
    checked: 0,
    notChecked: 0,
    problems: [],
  }));
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  fakePort = (fake.address() as { port: number }).port;
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
    (req as unknown as { user?: User }).user = actingAs;
    next();
  });
  ex.use('/api/v1/settings', settingsRoutes);
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

beforeEach(() => {
  arrHealth = [];
  rootFolders = [
    { id: 1, path: '/m', freeSpace: 500 * GB, totalSpace: 1024 * GB },
  ];
  indexers = [];
  indexerStatus = [];
  bazarrHealth = [];
  bazarrProviders = [];
  const settings = getSettings();
  settings.bazarr = {
    hostname: '',
    port: 6767,
    useSsl: false,
    urlBase: '',
    apiKey: '',
  };
  settings.backfill = { ...BACKFILL_DEFAULTS };
  settings.downloadClients = [];
  settings.plex = { ...settings.plex, ip: '' };
  settings.radarr = [radarr(0, 'Radarr', fakePort), radarr(1, 'Radarr 4K', 1)];
  settings.sonarr = [];
  settings.tautulli = {};
  settings.maintainerr = [
    {
      id: 0,
      name: 'Maintainerr',
      hostname: '127.0.0.1',
      port: fakePort,
      useSsl: false,
      urlBase: '',
      apiKey: '',
      showBadges: true,
      showDeletingSoon: true,
      allowKeep: true,
      keepDays: 0,
      soonDays: 14,
    },
  ];
});

const backdate = async (
  entity: 'media' | 'media_request',
  id: number,
  column: 'updatedAt' | 'createdAt',
  when: Date
) =>
  getRepository(entity === 'media' ? Media : MediaRequest)
    .createQueryBuilder()
    .update()
    .set({ [column]: when })
    .where('id = :id', { id })
    .execute();

describe('services', () => {
  it('reports each configured service, answering or not, by name', async () => {
    // The database is listed too on Postgres; it has a test of its own.
    const checks = (await health()).filter(
      (c) => c.group === 'services' && c.id !== 'database'
    );
    assert.deepEqual(checks.map((c) => `${c.name}:${c.status}`).sort(), [
      'Maintainerr:ok',
      'Radarr 4K:error',
      'Radarr:ok',
    ]);
    assert.match(byId(checks, 'radarr:0').detail!, /^\d+ ms · 500 GB free$/);
    assert.ok(byId(checks, 'radarr:1').detail, 'says why it failed');
  });

  it('names the subtitle providers Bazarr has paused, such as WhisperAI', async () => {
    getSettings().bazarr = {
      hostname: '127.0.0.1',
      port: fakePort,
      useSsl: false,
      urlBase: '',
      apiKey: 'k',
    };
    bazarrProviders = [
      { name: 'opensubtitlescom', status: 'Good', retry: '-' },
      { name: 'whisperai', status: 'ReadTimeout', retry: 'in 41 minutes' },
    ];
    bazarrHealth = [{ object: 'Sonarr', issue: 'Sonarr is not reachable' }];
    const bazarr = byId(await health(), 'bazarr');
    assert.equal(bazarr.status, 'warning');
    assert.match(bazarr.detail!, /^\d+ ms · 2 providers$/);
    assert.deepEqual(
      bazarr.items.map((i) => [i.title, i.detail]),
      [
        [
          'whisperai is paused',
          'after an error (ReadTimeout) · tries again in 41 minutes',
        ],
        ['Sonarr is not reachable', 'Sonarr'],
      ]
    );

    bazarrProviders = [{ name: 'whisperai', status: 'Good', retry: '-' }];
    bazarrHealth = [];
    assert.equal(byId(await health(), 'bazarr').status, 'ok');
  });

  it('passes on what Radarr itself reports, and a disk running low', async () => {
    arrHealth = [
      {
        source: 'IndexerStatusCheck',
        type: 'warning',
        message: 'Indexers unavailable due to failures: Nyaa',
      },
      { source: 'UpdateCheck', type: 'notice', message: 'An update is out' },
    ];
    rootFolders = [
      { id: 1, path: '/movies', freeSpace: 60 * GB, totalSpace: 1024 * GB },
      { id: 2, path: '/anime', freeSpace: 900 * GB, totalSpace: 1024 * GB },
    ];
    const radarr = byId(await health(), 'radarr:0');
    assert.equal(radarr.status, 'warning');
    assert.equal(radarr.count, 2);
    assert.deepEqual(
      radarr.items.map((i) => i.title),
      ['Indexers unavailable due to failures: Nyaa', 'Low on space: /movies']
    );
    assert.match(radarr.items[1].detail!, /60 GB free of 1\.0 TB \(6%\)/);

    rootFolders = [
      { id: 1, path: '/movies', freeSpace: 10 * GB, totalSpace: 1024 * GB },
    ];
    arrHealth = [];
    assert.equal(byId(await health(), 'radarr:0').status, 'error');
  });

  it('names the indexers Prowlarr has paused, and the download clients that do not answer', async () => {
    const settings = getSettings();
    settings.backfill = {
      ...BACKFILL_DEFAULTS,
      prowlarr: {
        hostname: '127.0.0.1',
        port: fakePort,
        useSsl: false,
        urlBase: '',
        apiKey: 'k',
      },
    };
    settings.downloadClients = [
      {
        id: 7,
        name: 'qBit',
        type: 'qbittorrent',
        hostname: '127.0.0.1',
        port: 1,
        useSsl: false,
        urlBase: '',
        apiKey: '',
        username: '',
        password: '',
      },
    ];
    indexers = [
      { id: 1, name: 'Nyaa', enable: true },
      { id: 2, name: 'Old one', enable: true },
      { id: 3, name: 'Turned off', enable: false },
    ];
    const soon = new Date(Date.now() + 2 * HOUR).toISOString();
    indexerStatus = [
      {
        indexerId: 1,
        disabledTill: soon,
        mostRecentFailure: new Date().toISOString(),
      },
      {
        indexerId: 2,
        mostRecentFailure: new Date(Date.now() - 9 * DAY).toISOString(),
      },
      { indexerId: 3, disabledTill: soon },
    ];
    const checks = await health();
    const prowlarr = byId(checks, 'prowlarr');
    assert.equal(prowlarr.status, 'warning');
    assert.deepEqual(
      prowlarr.items.map((i) => i.title),
      ['Nyaa'],
      'only one still paused or failing lately, and switched on'
    );
    assert.match(prowlarr.items[0].detail!, /paused for/);
    assert.equal(byId(checks, 'downloadClient:7').status, 'error');
  });

  it('shows each download client with its version, and what keeps Backfill from using it fully', async () => {
    const settings = getSettings();
    const client = {
      hostname: '127.0.0.1',
      port: 1,
      useSsl: false,
      urlBase: '',
      apiKey: '',
      username: '',
      password: '',
    };
    settings.downloadClients = [
      { ...client, id: 8, name: 'Deluge', type: 'deluge' },
      { ...client, id: 9, name: 'NZBGet', type: 'nzbget' },
    ];
    settings.backfill = {
      ...BACKFILL_DEFAULTS,
      enabled: true,
      torrentClientId: 8,
    };
    const mocks = [
      mock.method(DelugeAPI.prototype, 'getVersion', async () => '2.1.1'),
      mock.method(DelugeAPI.prototype, 'backfillProblems', async () => [
        "Deluge's Label plugin is off",
      ]),
      mock.method(NzbgetAPI.prototype, 'getVersion', async () => '24.3'),
    ];
    const problems = mock.method(
      NzbgetAPI.prototype,
      'backfillProblems',
      async () => ['should not be asked']
    );
    mocks.push(problems);
    try {
      const checks = await health();
      const deluge = byId(checks, 'downloadClient:8');
      assert.equal(deluge.status, 'warning');
      assert.match(deluge.detail!, /\d+ ms · Deluge 2\.1\.1/);
      assert.deepEqual(
        deluge.items.map((i) => [i.title, i.href]),
        [["Deluge's Label plugin is off", '/settings/backfill']]
      );
      // Not one Backfill uses: only whether it answers.
      const nzbget = byId(checks, 'downloadClient:9');
      assert.equal(nzbget.status, 'ok');
      assert.match(nzbget.detail!, /NZBGet 24\.3/);
      assert.equal(problems.mock.callCount(), 0);

      settings.backfill = { ...settings.backfill, enabled: false };
      assert.equal(byId(await health(), 'downloadClient:8').status, 'ok');
    } finally {
      for (const m of mocks) m.mock.restore();
    }
  });

  it('shows how many database connections are in use, on Postgres', async (t) => {
    if (dataSource.options.type !== 'postgres') {
      t.skip('SQLite has no connection limit');
      return;
    }
    const database = byId(await health(), 'database');
    assert.equal(database.status, 'ok');
    assert.match(database.detail!, /\d+ of \d+ connections/);
  });
});

describe('Backfill', () => {
  it('lists searches that failed, packs waiting on approval and failed downloads', async () => {
    getSettings().backfill = { ...BACKFILL_DEFAULTS, enabled: true };
    const series = getRepository(BackfillSeries);
    const row = (title: string, over: Partial<BackfillSeries>) =>
      series.save(
        new BackfillSeries({
          kind: 'series',
          serverId: 0,
          arrId: Math.floor(Math.random() * 1e6),
          title,
          status: 'stuck',
          ...over,
        })
      );
    await row('Cannot search', {
      status: 'stuck',
      searchError: 'Prowlarr: connect ECONNREFUSED',
      lastSearchedAt: new Date(),
    });
    await row('Fine', { status: 'none', lastSearchedAt: new Date() });
    await row('Has a pack', { status: 'found', lastSearchedAt: new Date() });
    const failed = await row('Dead swarm', { status: 'none' });
    await getRepository(BackfillJob).save(
      new BackfillJob({
        seriesId: failed.id,
        title: 'pack',
        status: 'failed',
        mode: 'missing',
        protocol: 'torrent',
        clientId: 1,
        files: [],
        error: 'Nothing downloaded for 12 hours',
        finishedAt: new Date(),
      })
    );
    const checks = (await health()).filter((c) => c.group === 'backfill');
    assert.deepEqual(
      checks.map((c) => `${c.id}:${c.status}:${c.items.map((i) => i.title)}`),
      [
        'backfillSearchErrors:warning:Cannot search',
        'backfillAwaiting:warning:Has a pack',
        'backfillFailed:warning:Dead swarm',
      ]
    );
    assert.match(checks[0].items[0].detail!, /ECONNREFUSED/);
    assert.match(checks[2].items[0].href!, /^\/backfill\/jobs\/\d+$/);
  });

  it('is left off the page while Backfill is off', async () => {
    const checks = await health();
    assert.equal(checks.filter((c) => c.group === 'backfill').length, 0);
  });
});

describe('requests, titles and users', () => {
  let user: User;

  beforeEach(async () => {
    user = await getRepository(User).save(
      new User({
        email: 'h@test.local',
        plexUsername: 'health-user',
        permissions: Permission.REQUEST,
        avatar: '',
      })
    );
  });

  const make = async (
    tmdbId: number,
    mediaStatus: MediaStatus,
    requestStatus: MediaRequestStatus,
    type = MediaType.MOVIE,
    tvdbId?: number
  ) => {
    const media = await getRepository(Media).save(
      new Media({ tmdbId, mediaType: type, status: mediaStatus, tvdbId })
    );
    // Saved as pending, then moved to the wanted status without the save
    // hooks: an approved save tries to send it straight away, and with no
    // default Radarr here that marks it failed. Approved-but-unsent really
    // arises from a send that errors, such as Radarr being down.
    const request = await getRepository(MediaRequest).save(
      new MediaRequest({
        type,
        media,
        requestedBy: user,
        status: MediaRequestStatus.PENDING,
        is4k: false,
      })
    );
    await getRepository(MediaRequest)
      .createQueryBuilder()
      .update()
      .set({ status: requestStatus })
      .where('id = :id', { id: request.id })
      .execute();
    return { media, request };
  };

  it('flags failed requests', async () => {
    await make(11, MediaStatus.PENDING, MediaRequestStatus.FAILED);
    const check = byId(await health(), 'failedRequests');
    assert.equal(check.status, 'error');
    assert.equal(check.count, 1);
    assert.equal(check.items[0].title, 'Movie 11');
    assert.equal(check.items[0].href, '/movie/11');
  });

  it('flags approved requests that never reached Radarr or Sonarr, but not fresh ones', async () => {
    const stuck = await make(
      21,
      MediaStatus.PENDING,
      MediaRequestStatus.APPROVED
    );
    await backdate(
      'media_request',
      stuck.request.id,
      'updatedAt',
      new Date(Date.now() - 2 * HOUR)
    );
    await make(22, MediaStatus.PENDING, MediaRequestStatus.APPROVED); // just approved
    const sent = await make(
      23,
      MediaStatus.PROCESSING,
      MediaRequestStatus.APPROVED
    );
    // Radarr added it, and gave it an id.
    await getRepository(Media).update(sent.media.id, { externalServiceId: 77 });
    await backdate(
      'media_request',
      sent.request.id,
      'updatedAt',
      new Date(Date.now() - 2 * HOUR)
    );

    const check = byId(await health(), 'neverSent');
    assert.deepEqual(
      check.items.map((i) => i.title),
      ['Movie 21']
    );
    assert.equal(check.status, 'error');
  });

  it('warns about requests waiting on approval for over a week', async () => {
    const old = await make(31, MediaStatus.PENDING, MediaRequestStatus.PENDING);
    await backdate(
      'media_request',
      old.request.id,
      'createdAt',
      new Date(Date.now() - 8 * DAY)
    );
    await make(32, MediaStatus.PENDING, MediaRequestStatus.PENDING);
    const check = byId(await health(), 'awaitingApproval');
    assert.deepEqual(
      [check.status, check.items.map((i) => i.title)],
      ['warning', ['Movie 31']]
    );
  });

  it('counts only titles that should have arrived by now', async () => {
    getSettings().sonarr = [
      {
        ...radarr(0, 'Sonarr', fakePort),
        activeLanguageProfileId: 1,
        enableSeasonFolders: true,
      } as never,
    ];
    radarrMovies = [
      {
        id: 1,
        title: 'Out',
        isAvailable: true,
        hasFile: false,
        monitored: true,
      },
      {
        id: 2,
        title: 'Not out',
        isAvailable: false,
        hasFile: false,
        monitored: true,
      },
    ];
    sonarrSeries = [
      {
        id: 10,
        title: 'Behind',
        statistics: {
          episodeCount: 10,
          episodeFileCount: 7,
          totalEpisodeCount: 12,
        },
      },
      {
        id: 11,
        title: 'Waiting',
        statistics: {
          episodeCount: 5,
          episodeFileCount: 5,
          totalEpisodeCount: 8,
        },
      },
    ];
    const processing = async (
      tmdbId: number,
      mediaType: MediaType,
      serviceId: number | null,
      externalServiceId: number | null
    ) => {
      const media = await getRepository(Media).save(
        new Media({
          tmdbId,
          mediaType,
          status: MediaStatus.PROCESSING,
          serviceId,
          externalServiceId,
        })
      );
      await backdate(
        'media',
        media.id,
        'updatedAt',
        new Date(Date.now() - 10 * DAY)
      );
    };
    await processing(61, MediaType.MOVIE, 0, 1); // released, no file
    await processing(62, MediaType.MOVIE, 0, 2); // not released yet
    await processing(63, MediaType.TV, 0, 10); // 3 aired episodes missing
    await processing(64, MediaType.TV, 0, 11); // waiting for new episodes
    await processing(65, MediaType.MOVIE, 0, 99); // gone from Radarr
    await processing(66, MediaType.MOVIE, null, null); // never linked
    await processing(67, MediaType.MOVIE, 1, 5); // its Radarr does not answer

    const check = byId(await health(), 'stuckProcessing');
    const lines = check.items
      .map((i) => `${i.title}: ${i.detail!.split(' · ')[0]}`)
      .sort();
    assert.deepEqual(lines, [
      'Movie 61: Released, not downloaded',
      'Movie 65: No longer in Radarr',
      'Movie 66: Not linked to Radarr',
      'Movie 67: Could not check Radarr',
      'Show 63: 3 aired episodes missing',
    ]);
    assert.equal(
      check.count,
      5,
      'the unreleased film and the series waiting on episodes are left out'
    );
  });

  it('warns about titles processing for over a week', async () => {
    const stuck = await getRepository(Media).save(
      new Media({
        tmdbId: 41,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
      })
    );
    await backdate(
      'media',
      stuck.id,
      'updatedAt',
      new Date(Date.now() - 8 * DAY)
    );
    await getRepository(Media).save(
      new Media({
        tmdbId: 42,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
      })
    );
    const check = byId(await health(), 'stuckProcessing');
    assert.deepEqual(
      [check.status, check.items.map((i) => i.title)],
      ['warning', ['Movie 41']]
    );
  });

  it('warns about requested series with no TVDB id, and only requested ones', async () => {
    await make(
      51,
      MediaStatus.PENDING,
      MediaRequestStatus.FAILED,
      MediaType.TV
    );
    await getRepository(Media).save(
      new Media({
        tmdbId: 52,
        mediaType: MediaType.TV,
        status: MediaStatus.UNKNOWN,
      })
    );
    await make(
      53,
      MediaStatus.PENDING,
      MediaRequestStatus.PENDING,
      MediaType.TV,
      999
    );
    const check = byId(await health(), 'missingTvdb');
    assert.deepEqual(
      check.items.map((i) => [i.title, i.href]),
      [['Show 51', '/tv/51']]
    );
  });

  it('warns about users whose Plex sign-in expired', async () => {
    await getRepository(User).update(user.id, {
      plexTokenExpiredAt: new Date(Date.now() - 3 * DAY),
    });
    const check = byId(await health(), 'plexSignIn');
    assert.equal(check.status, 'warning');
    assert.deepEqual(
      check.items.map((i) => [i.title, i.detail, i.href]),
      [['health-user', 'expired 3 days ago', `/users/${user.id}`]]
    );
  });

  it('keeps requests with no title out of the other checks, listed on their own', async () => {
    // What the live page showed: every "never sent" row was a request no
    // longer linked to a title.
    const orphan = async (status: MediaRequestStatus) => {
      const inserted = await getRepository(MediaRequest)
        .createQueryBuilder()
        .insert()
        .values({ status, type: MediaType.TV, is4k: false, requestedBy: user })
        .execute();
      const id = inserted.identifiers[0].id as number;
      await backdate(
        'media_request',
        id,
        'updatedAt',
        new Date(Date.now() - 2 * HOUR)
      );
      return id;
    };
    const approved = await orphan(MediaRequestStatus.APPROVED);
    const failed = await orphan(MediaRequestStatus.FAILED);

    const checks = await health();
    assert.equal(
      byId(checks, 'neverSent').count,
      0,
      'an orphan is not an unsent request'
    );
    assert.equal(byId(checks, 'failedRequests').count, 0, 'nor a failed one');

    const unlinked = byId(checks, 'unlinkedRequests');
    assert.equal(unlinked.status, 'warning');
    assert.deepEqual(
      unlinked.items.map((i) => i.title).sort(),
      [`Request #${approved}`, `Request #${failed}`].sort()
    );
    assert.match(
      unlinked.items.find((i) => i.title === `Request #${failed}`)!.detail!,
      /health-user · failed · made/
    );
  });

  it('removes only requests with no title, with their seasons', async () => {
    const orphanWithSeason = await getRepository(MediaRequest)
      .createQueryBuilder()
      .insert()
      .values({
        status: MediaRequestStatus.APPROVED,
        type: MediaType.TV,
        is4k: false,
        requestedBy: user,
      })
      .execute();
    const orphanId = orphanWithSeason.identifiers[0].id as number;
    await getRepository(SeasonRequest).save(
      new SeasonRequest({
        seasonNumber: 1,
        status: MediaRequestStatus.APPROVED,
        request: { id: orphanId } as MediaRequest,
      })
    );
    await getRepository(MediaRequest)
      .createQueryBuilder()
      .insert()
      .values({
        status: MediaRequestStatus.FAILED,
        type: MediaType.MOVIE,
        is4k: false,
        requestedBy: user,
      })
      .execute();
    const linked = await make(
      71,
      MediaStatus.PENDING,
      MediaRequestStatus.PENDING
    );

    const removed = await new Promise<{
      status: number;
      body: { removed: number };
    }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/settings/health/unlinked-requests',
          method: 'DELETE',
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });

    assert.deepEqual([removed.status, removed.body.removed], [200, 2]);
    assert.deepEqual(
      (await getRepository(MediaRequest).find()).map((r) => r.id),
      [linked.request.id],
      'the linked request stays'
    );
    assert.equal(
      await getRepository(SeasonRequest).countBy({ request: { id: orphanId } }),
      0,
      "the orphan's season went with it"
    );
    assert.equal(byId(await health(), 'unlinkedRequests').count, 0);
  });

  it('marks as searchable only titles Radarr or Sonarr has', async () => {
    getSettings().sonarr = [
      {
        ...radarr(0, 'Sonarr', fakePort),
        activeLanguageProfileId: 1,
        enableSeasonFolders: true,
      } as never,
    ];
    radarrMovies = [
      {
        id: 1,
        title: 'Out',
        isAvailable: true,
        hasFile: false,
        monitored: true,
      },
    ];
    sonarrSeries = [
      {
        id: 10,
        title: 'Behind',
        statistics: {
          episodeCount: 3,
          episodeFileCount: 1,
          totalEpisodeCount: 3,
        },
      },
    ];
    const processing = async (
      tmdbId: number,
      mediaType: MediaType,
      serviceId: number | null,
      externalServiceId: number | null
    ) => {
      const media = await getRepository(Media).save(
        new Media({
          tmdbId,
          mediaType,
          status: MediaStatus.PROCESSING,
          serviceId,
          externalServiceId,
        })
      );
      await backdate(
        'media',
        media.id,
        'updatedAt',
        new Date(Date.now() - 10 * DAY)
      );
      return media;
    };
    const movie = await processing(81, MediaType.MOVIE, 0, 1);
    const series = await processing(82, MediaType.TV, 0, 10);
    await processing(83, MediaType.MOVIE, 0, 99);

    const items = byId(await health(), 'stuckProcessing').items as ({
      title: string;
    } & { searchable?: { mediaId: number; is4k: boolean } })[];
    assert.deepEqual(
      items.map((i) => [i.title, i.searchable ?? null]).sort(),
      [
        ['Movie 81', { mediaId: movie.id, is4k: false, mediaType: 'movie' }],
        ['Movie 83', null],
        ['Show 82', { mediaId: series.id, is4k: false, mediaType: 'tv' }],
      ].sort()
    );
  });

  describe('searching for what is missing', () => {
    const post = (route: string, body?: unknown) =>
      new Promise<{
        status: number;
        body: { service?: string; searched?: number; message?: string };
      }>((resolve, reject) => {
        const payload = JSON.stringify(body ?? {});
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: route,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            let raw = '';
            res.on('data', (c) => (raw += c));
            res.on('end', () => {
              let parsed = {};
              try {
                parsed = raw ? JSON.parse(raw) : {};
              } catch {
                // An error page rather than JSON; the status is what matters.
              }
              resolve({ status: res.statusCode ?? 0, body: parsed });
            });
          }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

    beforeEach(async () => {
      commands = [];
      getSettings().sonarr = [
        {
          ...radarr(0, 'Sonarr', fakePort),
          activeLanguageProfileId: 1,
          enableSeasonFolders: true,
        } as never,
      ];
      actingAs = await getRepository(User).save(
        new User({
          email: 'search-admin@test.local',
          plexUsername: 'Alex',
          permissions: Permission.ADMIN,
          avatar: '',
        })
      );
    });

    it('asks Sonarr for exactly the monitored, aired episodes with no file', async () => {
      const hour = 60 * 60 * 1000;
      sonarrEpisodes = [
        {
          id: 1,
          seasonNumber: 1,
          monitored: true,
          hasFile: true,
          airDateUtc: new Date(Date.now() - 100 * hour).toISOString(),
        },
        {
          id: 2,
          seasonNumber: 1,
          monitored: true,
          hasFile: false,
          airDateUtc: new Date(Date.now() - 50 * hour).toISOString(),
        },
        {
          id: 3,
          seasonNumber: 1,
          monitored: false,
          hasFile: false,
          airDateUtc: new Date(Date.now() - 50 * hour).toISOString(),
        },
        {
          id: 4,
          seasonNumber: 2,
          monitored: true,
          hasFile: false,
          airDateUtc: new Date(Date.now() + 50 * hour).toISOString(),
        },
        {
          id: 5,
          seasonNumber: 2,
          monitored: true,
          hasFile: false,
          airDateUtc: new Date(Date.now() - 1 * hour).toISOString(),
        },
        {
          id: 6,
          seasonNumber: 2,
          monitored: true,
          hasFile: false,
          airDateUtc: null,
        },
        // Season 3: every aired episode missing, so one season search.
        {
          id: 7,
          seasonNumber: 3,
          monitored: true,
          hasFile: false,
          airDateUtc: new Date(Date.now() - 30 * hour).toISOString(),
        },
        {
          id: 8,
          seasonNumber: 3,
          monitored: true,
          hasFile: false,
          airDateUtc: new Date(Date.now() - 20 * hour).toISOString(),
        },
      ];
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 91,
          mediaType: MediaType.TV,
          status: MediaStatus.PROCESSING,
          serviceId: 0,
          externalServiceId: 10,
        })
      );

      const { status, body } = await post(
        `/api/v1/media/${media.id}/search-missing`
      );
      assert.deepEqual(
        [status, body.searched, body.service],
        [200, 4, 'Sonarr']
      );
      assert.deepEqual(
        commands,
        [
          { name: 'SeasonSearch', seriesId: 10, seasonNumber: 3 },
          { name: 'EpisodeSearch', episodeIds: [2, 5] },
        ],
        'a whole missing season searched as one; the scattered rest together; never the one with a file, the unmonitored one, or unaired ones'
      );

      const event = await getRepository(MediaEvent).findOneByOrFail({
        tmdbId: 91,
        type: 'searched' as never,
      });
      assert.equal(event.detail, '4 missing episodes, in Sonarr');
      assert.equal(event.userId, actingAs!.id);
    });

    it('asks Radarr to search for a film', async () => {
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 92,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
          serviceId: 0,
          externalServiceId: 1,
        })
      );
      const { status } = await post(`/api/v1/media/${media.id}/search-missing`);
      assert.equal(status, 200);
      assert.deepEqual(commands, [{ name: 'MoviesSearch', movieIds: [1] }]);
    });

    it('says so, without searching, when nothing is missing or it is not linked', async () => {
      sonarrEpisodes = [
        {
          id: 1,
          seasonNumber: 1,
          monitored: true,
          hasFile: true,
          airDateUtc: new Date(Date.now() - 3600000).toISOString(),
        },
      ];
      const complete = await getRepository(Media).save(
        new Media({
          tmdbId: 93,
          mediaType: MediaType.TV,
          status: MediaStatus.PROCESSING,
          serviceId: 0,
          externalServiceId: 10,
        })
      );
      const unlinked = await getRepository(Media).save(
        new Media({
          tmdbId: 94,
          mediaType: MediaType.TV,
          status: MediaStatus.PROCESSING,
        })
      );
      assert.equal(
        (await post(`/api/v1/media/${complete.id}/search-missing`)).status,
        409
      );
      assert.equal(
        (await post(`/api/v1/media/${unlinked.id}/search-missing`)).status,
        409
      );
      assert.deepEqual(commands, []);
    });

    it('reports a film search Radarr refused, rather than claiming it started', async () => {
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 96,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
          serviceId: 1,
          externalServiceId: 1,
        })
      );
      assert.equal(
        (await post(`/api/v1/media/${media.id}/search-missing`)).status,
        502,
        'Radarr 4K here does not answer'
      );
    });

    it('searches everything stuck in one go: films together, series by season', async () => {
      const hour = 60 * 60 * 1000;
      radarrMovies = [
        {
          id: 1,
          title: 'A',
          isAvailable: true,
          hasFile: false,
          monitored: true,
        },
        {
          id: 2,
          title: 'B',
          isAvailable: true,
          hasFile: false,
          monitored: true,
        },
        {
          id: 3,
          title: 'Not out',
          isAvailable: false,
          hasFile: false,
          monitored: true,
        },
      ];
      sonarrSeries = [
        {
          id: 10,
          title: 'Behind',
          statistics: {
            episodeCount: 2,
            episodeFileCount: 0,
            totalEpisodeCount: 2,
          },
        },
      ];
      sonarrEpisodes = [
        {
          id: 7,
          seasonNumber: 1,
          monitored: true,
          hasFile: false,
          airDateUtc: new Date(Date.now() - 30 * hour).toISOString(),
        },
        {
          id: 8,
          seasonNumber: 1,
          monitored: true,
          hasFile: false,
          airDateUtc: new Date(Date.now() - 20 * hour).toISOString(),
        },
      ];
      for (const [tmdbId, mediaType, externalServiceId] of [
        [101, MediaType.MOVIE, 1],
        [102, MediaType.MOVIE, 2],
        [103, MediaType.MOVIE, 3],
        [104, MediaType.TV, 10],
      ] as const) {
        const media = await getRepository(Media).save(
          new Media({
            tmdbId,
            mediaType,
            status: MediaStatus.PROCESSING,
            serviceId: 0,
            externalServiceId,
          })
        );
        await backdate(
          'media',
          media.id,
          'updatedAt',
          new Date(Date.now() - 10 * DAY)
        );
      }

      const { status, body } = await post(
        '/api/v1/settings/health/search-all-missing'
      );
      assert.equal(status, 200);
      assert.deepEqual(body, { titles: 3, episodes: 4, failed: 0 });
      assert.deepEqual(
        commands,
        [
          { name: 'MoviesSearch', movieIds: [1, 2] },
          { name: 'SeasonSearch', seriesId: 10, seasonNumber: 1 },
        ],
        'one command for both films; the unreleased one left alone'
      );
      assert.equal(
        await getRepository(MediaEvent).countBy({ type: 'searched' as never }),
        3
      );
    });

    it('is for request managers and admins only', async () => {
      actingAs = await getRepository(User).save(
        new User({
          email: 'search-plain@test.local',
          plexUsername: 'plain',
          permissions: Permission.REQUEST,
          avatar: '',
        })
      );
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 95,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
          serviceId: 0,
          externalServiceId: 1,
        })
      );
      assert.equal(
        (await post(`/api/v1/media/${media.id}/search-missing`)).status,
        403
      );
      assert.deepEqual(commands, []);
    });
  });

  it('pages through a long list, ten at a time', async () => {
    const get = (path: string) =>
      new Promise<{
        status: number;
        body: { count: number; items: { title: string }[] };
      }>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path }, (res) => {
            let raw = '';
            res.on('data', (c) => (raw += c));
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
              } catch {
                resolve({
                  status: res.statusCode ?? 0,
                  body: { count: 0, items: [] },
                });
              }
            });
          })
          .on('error', reject);
      });

    for (let i = 0; i < 12; i++) {
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 200 + i,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
        })
      );
      await backdate(
        'media',
        media.id,
        'updatedAt',
        new Date(Date.now() - (30 - i) * DAY)
      );
    }
    const first = byId(await health(), 'stuckProcessing');
    assert.deepEqual([first.count, first.items.length], [12, 10]);

    const second = await get(
      '/api/v1/settings/health/checks/stuckProcessing?page=2'
    );
    assert.deepEqual(
      [second.status, second.body.count, second.body.items.map((i) => i.title)],
      [200, 12, ['Movie 210', 'Movie 211']],
      'the last two, oldest first as on page one'
    );
    const beyond = await get(
      '/api/v1/settings/health/checks/stuckProcessing?page=5'
    );
    assert.deepEqual([beyond.body.count, beyond.body.items.length], [12, 0]);

    // A database-backed check pages the same way.
    for (let i = 0; i < 11; i++) {
      await make(300 + i, MediaStatus.PENDING, MediaRequestStatus.FAILED);
    }
    const failed = await get(
      '/api/v1/settings/health/checks/failedRequests?page=2'
    );
    assert.deepEqual([failed.body.count, failed.body.items.length], [11, 1]);

    assert.equal(
      (await get('/api/v1/settings/health/checks/nonsense')).status,
      404
    );
  });

  it('lists folders Plex matched to another title, opening the right one', async (t) => {
    await getRepository(Media).save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 288673,
        tvdbId: 455755,
        status: MediaStatus.PARTIALLY_AVAILABLE,
      })
    );
    t.mock.method(plexMatchCheck, 'lastReport', async () => ({
      finishedAt: new Date().toISOString(),
      running: false,
      checked: 40,
      notChecked: 0,
      problems: [
        {
          kind: 'series' as const,
          folder: 'Carrie',
          reason: 'other' as const,
          expected: {
            title: 'Carrie',
            year: 2026,
            tvdbId: 455755,
            server: 'Sonarr',
          },
          mediaServer: 'Plex',
          matched: {
            title: 'The Carrie Diaries',
            year: 2013,
            key: '126741',
          },
        },
      ],
    }));
    const check = byId(await health(), 'plexMatches');
    assert.equal(check.status, 'warning');
    assert.deepEqual(
      check.items.map((i) => [i.title, i.detail, i.href]),
      [
        [
          'Plex matched "Carrie" to The Carrie Diaries (2013)',
          'Sonarr has Carrie (2026) there (Sonarr: TVDB 455755) · Fix Match in Plex, searching tvdb-455755',
          '/tv/288673',
        ],
      ]
    );
  });

  it('is all green with nothing wrong', async () => {
    const checks = (await health()).filter((c) => c.group !== 'services');
    assert.deepEqual(
      checks.map((c) => `${c.id}:${c.status}`),
      [
        'failedRequests:ok',
        'neverSent:ok',
        'awaitingApproval:ok',
        'unlinkedRequests:ok',
        'stuckProcessing:ok',
        'missingTvdb:ok',
        'collectionGaps:ok',
        'plexMatches:ok',
        'plexSignIn:ok',
      ]
    );
  });
});
