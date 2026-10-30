import QBittorrentAPI from '@server/api/downloadclients/qbittorrent';
import ProwlarrAPI from '@server/api/prowlarr';
import { getRepository } from '@server/datasource';
import AgentRun from '@server/entity/AgentRun';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import { User } from '@server/entity/User';
import { clearAiCache } from '@server/lib/ai';
import backfill from '@server/lib/backfill/engine';
import BackfillLidarr from '@server/lib/backfill/lidarr';
import backfillNotices from '@server/lib/backfill/notices';
import type { PlanEntry } from '@server/lib/backfill/plan';
import type { SonarrEpisode } from '@server/lib/backfill/sonarr';
import BackfillSonarr from '@server/lib/backfill/sonarr';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { Permission } from '@server/lib/permissions';
import type { LidarrSettings, SonarrSettings } from '@server/lib/settings';
import { BACKFILL_DEFAULTS, getSettings } from '@server/lib/settings';
import { isAuthenticated } from '@server/middleware/auth';
import backfillRoutes from '@server/routes/backfill';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';

setupTestDb();

/*
 * Approving a pack, end to end, through the real validator: Prowlarr hands
 * over a .torrent, qBittorrent downloads only the chosen files, Sonarr's
 * manual import takes them, the torrent is removed and admins are told.
 * Prowlarr, qBittorrent and Sonarr are stubbed at their API clients.
 */

const ben = (value: unknown): Buffer => {
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([Buffer.from(`${b.length}:`), b]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      Buffer.from('l'),
      ...value.map(ben),
      Buffer.from('e'),
    ]);
  }
  const dict = value as Record<string, unknown>;
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(dict)
      .sort()
      .flatMap((k) => [ben(k), ben(dict[k])]),
    Buffer.from('e'),
  ]);
};

const INFO = {
  name: '[Tengu] Kitsuraga',
  'piece length': 4194304,
  pieces: Buffer.alloc(20),
  files: [
    { length: 400, path: ['S3', '[Tengu] Kitsuraga - S03E06 (101).mkv'] },
    { length: 300, path: ['S3', '[Tengu] Kitsuraga - S03E07 (102).mkv'] },
    { length: 200, path: ['S1', '[Tengu] Kitsuraga - S01E01 (001).mkv'] },
  ],
};
const TORRENT = ben({ announce: 'udp://tracker', info: INFO });
const HASH = createHash('sha1').update(ben(INFO)).digest('hex');

const quality = {
  quality: { id: 7, name: 'Bluray-1080p' },
  revision: { version: 1, real: 0 },
};
const entry = (
  index: number,
  file: string,
  episodeId: number,
  action: PlanEntry['action'],
  replaces: number
): PlanEntry => ({
  index,
  path: `[Tengu] Kitsuraga/S3/${file}`,
  size: index === 0 ? 400 : 300,
  judgedAs: file,
  episodeIds: [episodeId],
  absolute: episodeId,
  quality,
  languages: [{ id: 8, name: 'Japanese' }],
  releaseGroup: 'Tengu',
  score: 700,
  action,
  replaces,
});
const PLAN: PlanEntry[] = [
  entry(0, '[Tengu] Kitsuraga - S03E06 (101).mkv', 101, 'fill', 0),
  entry(1, '[Tengu] Kitsuraga - S03E07 (102).mkv', 102, 'upgrade', 1),
  {
    ...entry(2, '[Tengu] Kitsuraga - S01E01 (001).mkv', 1, 'skip', 0),
    path: '[Tengu] Kitsuraga/S1/[Tengu] Kitsuraga - S01E01 (001).mkv',
  },
];

let admin: User;
let member: User;
let actingAs: User;
let app: Server | undefined;
let port = 0;
let sent: { type: Notification; payload: NotificationPayload }[] = [];
let episodes: SonarrEpisode[] = [];
let filePrio: { indexes: number[]; priority: number }[] = [];
let imports: { path: string; episodeIds: number[] }[][] = [];
let deleted: string[] = [];
let torrentDone = false;
/** What qBittorrent says the torrent is doing, when not the usual. */
let torrentState: string | undefined;
/** The .torrent Prowlarr hands over next. */
let torrentData: Buffer = TORRENT;

const ep = (id: number, hasFile: boolean, fileId = 0): SonarrEpisode => ({
  id,
  seriesId: 1279,
  seasonNumber: 3,
  episodeNumber: id,
  absoluteEpisodeNumber: id,
  hasFile,
  monitored: true,
  episodeFileId: fileId,
  airDateUtc: '2005-01-01T00:00:00Z',
});

const call = async (
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

beforeEach(async () => {
  backfillNotices.flush();
  sent = [];
  clearAiCache();
  filePrio = [];
  imports = [];
  deleted = [];
  torrentDone = false;
  torrentState = undefined;
  torrentData = TORRENT;
  episodes = [ep(101, false), ep(102, true, 500)];

  const settings = getSettings();
  settings.backfill = {
    ...BACKFILL_DEFAULTS,
    enabled: true,
    prowlarr: {
      ...BACKFILL_DEFAULTS.prowlarr,
      hostname: 'prowlarr',
      apiKey: 'k',
    },
    torrentClientId: 1,
    minFreeSpaceGb: 200,
  };
  settings.downloadClients = [
    {
      id: 1,
      name: 'qBittorrent',
      type: 'qbittorrent',
      hostname: 'qbittorrent',
      port: 8080,
      useSsl: false,
      urlBase: '',
      apiKey: '',
      username: '',
      password: '',
    },
  ];
  settings.sonarr = [
    {
      id: 0,
      name: 'Sonarr',
      hostname: 'sonarr',
      port: 8989,
      apiKey: 'x',
      useSsl: false,
      activeProfileId: 13,
      activeProfileName: 'Anime 1080p',
      activeDirectory: '/anime',
      tags: [],
      is4k: false,
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      tagRequests: false,
      overrideRule: [],
      seriesType: 'anime',
      animeSeriesType: 'anime',
    } as unknown as SonarrSettings,
  ];

  mock.method(
    notificationManager,
    'sendNotification',
    (type: Notification, payload: NotificationPayload) => {
      sent.push({ type, payload });
    }
  );
  mock.method(ProwlarrAPI.prototype, 'fetchRelease', async () => ({
    kind: 'torrent',
    data: torrentData,
  }));
  mock.method(BackfillSonarr.prototype, 'getSeriesDetail', async () => ({
    id: 1279,
    title: 'Kitsuraga',
    year: 2002,
    tvdbId: 63914,
    seriesType: 'anime',
    qualityProfileId: 13,
    path: '/anime/Kitsuraga',
  }));
  mock.method(BackfillSonarr.prototype, 'getRootFoldersNow', async () => [
    { path: '/anime', freeSpace: 10 * 1024 ** 4 },
  ]);
  mock.method(
    BackfillSonarr.prototype,
    'getSeriesEpisodes',
    async () => episodes
  );
  mock.method(BackfillSonarr.prototype, 'getRemotePathMappings', async () => [
    {
      host: 'qbittorrent',
      remotePath: '/downloads/',
      localPath: '/data/torrents/',
    },
  ]);
  mock.method(
    BackfillSonarr.prototype,
    'manualImport',
    async (files: { path: string; episodeIds: number[] }[]) => {
      imports.push(
        files.map((f) => ({ path: f.path, episodeIds: f.episodeIds }))
      );
      return 77;
    }
  );
  mock.method(BackfillSonarr.prototype, 'getCommand', async () => ({
    id: 77,
    name: 'ManualImport',
    status: 'completed',
  }));
  mock.method(
    QBittorrentAPI.prototype,
    'ensureCategory',
    async () => undefined
  );
  let added = false;
  mock.method(QBittorrentAPI.prototype, 'addTorrent', async () => {
    added = true;
  });
  mock.method(QBittorrentAPI.prototype, 'getFiles', async () =>
    INFO.files.map((f, index) => ({
      index,
      name: [INFO.name, ...f.path].join('/'),
      size: f.length,
      progress: torrentDone && index < 2 ? 1 : 0,
      priority: index < 2 ? 1 : 0,
    }))
  );
  mock.method(
    QBittorrentAPI.prototype,
    'setFilePriority',
    async (_hash: string, indexes: number[], priority: number) => {
      filePrio.push({ indexes: [...indexes].sort(), priority });
    }
  );
  mock.method(QBittorrentAPI.prototype, 'startTorrent', async () => undefined);
  mock.method(QBittorrentAPI.prototype, 'getCategoryTorrents', async () => []);
  mock.method(QBittorrentAPI.prototype, 'stopTorrent', async () => undefined);
  mock.method(QBittorrentAPI.prototype, 'getTorrent', async () =>
    added ? torrent() : undefined
  );
  const torrent = () => ({
    hash: HASH,
    name: INFO.name,
    state: torrentState ?? (torrentDone ? 'stoppedUP' : 'downloading'),
    progress: torrentDone ? 1 : 0.5,
    size: 700,
    amount_left: torrentDone ? 0 : 350,
    eta: 60,
    dlspeed: 1000,
    save_path: '/downloads/backfill',
    content_path: '/downloads/backfill/[Tengu] Kitsuraga',
  });
  mock.method(
    QBittorrentAPI.prototype,
    'deleteTorrent',
    async (hash: string) => {
      deleted.push(hash);
      added = false;
    }
  );

  const users = getRepository(User);
  admin = await users.save(
    new User({
      email: 'b-admin@test.local',
      plexUsername: 'b-admin',
      permissions: Permission.ADMIN,
      avatar: '',
    })
  );
  member = await users.save(
    new User({
      email: 'b-member@test.local',
      plexUsername: 'b-member',
      permissions: Permission.MANAGE_REQUESTS,
      avatar: '',
    })
  );
  // Loaded back, as the session would load them, so they have a display name.
  admin = await users.findOneOrFail({ where: { id: admin.id } });
  member = await users.findOneOrFail({ where: { id: member.id } });
  actingAs = admin;

  if (!app) {
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
    ex.use(
      '/api/v1/backfill',
      isAuthenticated(Permission.ADMIN),
      backfillRoutes
    );
    ex.use(
      (
        err: { status?: number; message: string },
        _req: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: express.NextFunction
      ) => res.status(err.status ?? 500).json({ message: err.message })
    );
    app = await new Promise<Server>((resolve) => {
      const s = ex.listen(0, () => resolve(s));
    });
    port = (app.address() as { port: number }).port;
  }
});

afterEach(() => mock.restoreAll());
after(() => app?.close());

const seed = async () => {
  const series = await getRepository(BackfillSeries).save(
    new BackfillSeries({
      serverId: 0,
      arrId: 1279,
      tmdbId: 58371,
      tvdbId: 63914,
      title: 'Kitsuraga',
      year: 2002,
      seriesType: 'anime',
      status: 'found',
      missing: 1,
      searchTerms: [],
    })
  );
  const candidate = await getRepository(BackfillCandidate).save(
    new BackfillCandidate({
      seriesId: series.id,
      guid: 'https://indexer/1',
      title: '[Tengu] Kitsuraga (Complete Series) [BD 1080p]',
      indexer: 'Uindex',
      indexerId: 45,
      protocol: 'torrent',
      size: 900,
      seeders: 211,
      downloadUrl: 'http://prowlarr:9696/45/download?apikey=k',
      status: 'ready',
      plan: PLAN,
      summary: {
        fill: 1,
        upgrade: 1,
        skip: 1,
        reject: 0,
        covered: 2,
        bytes: 700,
        fillBytes: 400,
        replaces: 1,
        quality: 'Bluray-1080p',
        score: 700,
        sonarrSeesTitle: false,
      },
    })
  );
  return { series, candidate };
};

describe('Backfill routes', () => {
  it('are for admins only', async () => {
    actingAs = member;
    const res = await call('GET', '/api/v1/backfill');
    assert.equal(res.status, 403);
  });

  it('answer the overview, and never send Prowlarr’s links', async () => {
    await seed();
    const res = await call('GET', '/api/v1/backfill');
    assert.equal(res.status, 200);
    assert.equal(res.body.readiness.ready, true);
    assert.equal(res.body.stats.awaiting, 1);
    assert.equal(res.body.awaiting[0].series.title, 'Kitsuraga');
    assert.ok(!JSON.stringify(res.body).includes('apikey'));
  });

  it('refuse a mode the spec does not allow', async () => {
    const { candidate } = await seed();
    const res = await call(
      'POST',
      `/api/v1/backfill/candidates/${candidate.id}/approve`,
      { mode: 'everything' }
    );
    assert.equal(res.status, 400);
  });

  it('need the series named before replacing files', async () => {
    const { candidate } = await seed();
    const res = await call(
      'POST',
      `/api/v1/backfill/candidates/${candidate.id}/approve`,
      { mode: 'all' }
    );
    assert.equal(res.status, 400);
    assert.match(res.body.message, /replaces 1 file on disk/);
    assert.equal(await getRepository(BackfillJob).count(), 0);
  });

  it('say an approval made with the API key was made with it', async () => {
    const { candidate } = await seed();
    getSettings().main.apiKey = 'the-api-key';
    const res = await call(
      'POST',
      `/api/v1/backfill/candidates/${candidate.id}/approve`,
      { mode: 'missing' },
      { 'X-Api-Key': 'the-api-key' }
    );
    assert.equal(res.status, 200);
    const job = await getRepository(BackfillJob).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.equal(job.approvedByName, `${admin.displayName} (API key)`);
    assert.equal(job.approvedById, admin.id);
    assert.match(job.log[0].message, /\(API key\) approved 1 files/);
  });

  it('approve, download only the chosen files, import, clean up and tell admins', async () => {
    const { series, candidate } = await seed();
    const res = await call(
      'POST',
      `/api/v1/backfill/candidates/${candidate.id}/approve`,
      { mode: 'all', confirm: 'kitsuraga' }
    );
    assert.equal(res.status, 200);
    const jobs = getRepository(BackfillJob);
    let job = await jobs.findOneOrFail({ where: { id: res.body.id } });
    assert.equal(job.status, 'downloading');
    assert.equal(typeof job.size, 'number', 'sizes are numbers on Postgres');
    assert.equal(job.downloadId, HASH);
    assert.equal(job.approvedByName, admin.displayName);
    assert.deepEqual(filePrio, [
      { indexes: [2], priority: 0 },
      { indexes: [0, 1], priority: 1 },
    ]);
    assert.equal(
      (
        await getRepository(BackfillCandidate).findOneOrFail({
          where: { id: candidate.id },
        })
      ).status,
      'approved'
    );
    assert.equal(
      (
        await getRepository(BackfillSeries).findOneOrFail({
          where: { id: series.id },
        })
      ).status,
      'downloading'
    );

    // Still downloading: nothing is imported.
    await backfill.tick();
    assert.equal(imports.length, 0);

    // Done: the two files go to Sonarr, by the paths Sonarr sees.
    torrentDone = true;
    await backfill.tick();
    job = await jobs.findOneOrFail({ where: { id: job.id } });
    assert.equal(job.status, 'importing');
    assert.deepEqual(imports[0], [
      {
        path: '/data/torrents/backfill/[Tengu] Kitsuraga/S3/[Tengu] Kitsuraga - S03E06 (101).mkv',
        episodeIds: [101],
      },
      {
        path: '/data/torrents/backfill/[Tengu] Kitsuraga/S3/[Tengu] Kitsuraga - S03E07 (102).mkv',
        episodeIds: [102],
      },
    ]);

    // Sonarr has them: checked, cleaned up, reported.
    episodes = [ep(101, true, 900), ep(102, true, 901)];
    await backfill.tick();
    job = await jobs.findOneOrFail({ where: { id: job.id } });
    assert.equal(job.status, 'done');
    assert.equal(job.imported, 2);
    assert.equal(job.replaced, 1);
    assert.deepEqual(deleted, [HASH]);
    assert.equal(
      (
        await getRepository(BackfillSeries).findOneOrFail({
          where: { id: series.id },
        })
      ).status,
      'done'
    );
    backfillNotices.flush();
    const report = sent.find((s) => s.type === Notification.BACKFILL);
    assert.ok(report);
    assert.equal(report.payload.actionUrl, `/backfill/jobs/${job.id}`);
    assert.equal(report.payload.notifyAdmin, true);
  });

  it('stop listing a title as awaiting approval once its backfill starts', async () => {
    const { series, candidate } = await seed();
    await getRepository(BackfillCandidate).save(
      new BackfillCandidate({
        seriesId: series.id,
        guid: 'https://indexer/other',
        title: '[Other] Kitsuraga 101 [1080p]',
        indexer: 'Nyaa',
        indexerId: 2,
        protocol: 'torrent',
        size: 400,
        seeders: 3,
        status: 'ready',
        plan: [entry(0, 'other.mkv', 101, 'fill', 0)],
        summary: candidate.summary,
      })
    );
    const before = await call('GET', '/api/v1/backfill');
    assert.equal(before.body.awaiting.length, 1);
    await call('POST', `/api/v1/backfill/candidates/${candidate.id}/approve`, {
      mode: 'all',
      confirm: 'kitsuraga',
    });
    const after = await call('GET', '/api/v1/backfill');
    assert.deepEqual(after.body.awaiting, []);
    assert.equal(after.body.stats.awaiting, 0);
    assert.equal(after.body.jobs.length, 1);

    // Filled: the other pack was judged against files that are gone now,
    // and is not offered once the title is done.
    torrentDone = true;
    await backfill.tick();
    episodes = [ep(101, true, 900), ep(102, true, 901)];
    await backfill.tick();
    const done = await call('GET', '/api/v1/backfill?filter=done');
    assert.equal(done.body.series[0].status, 'done');
    assert.equal(done.body.series[0].readyCount, 0);
    assert.deepEqual(done.body.awaiting, []);
    assert.equal(
      await getRepository(BackfillCandidate).count({
        where: { status: 'ready' },
      }),
      0
    );
  });

  it('keep the download when Sonarr turns a file down, and wait for the import before ending', async () => {
    const { candidate } = await seed();
    const res = await call(
      'POST',
      `/api/v1/backfill/candidates/${candidate.id}/approve`,
      { mode: 'all', confirm: 'kitsuraga' }
    );
    torrentDone = true;
    await backfill.tick();
    const jobs = getRepository(BackfillJob);
    assert.equal(
      (await jobs.findOneOrFail({ where: { id: res.body.id } })).status,
      'importing'
    );
    const ending = await call(
      'POST',
      `/api/v1/backfill/jobs/${res.body.id}/end`
    );
    assert.equal(ending.status, 400);
    assert.match(ending.body.message, /being imported/);

    episodes = [ep(101, true, 900), ep(102, true, 500)];
    await backfill.tick();
    const job = await jobs.findOneOrFail({ where: { id: res.body.id } });
    assert.equal(job.status, 'done');
    assert.equal(job.imported, 1);
    assert.equal(job.rejected, 1);
    assert.deepEqual(deleted, [], 'what did not import is left to import');
  });

  it('follow a title only when told whether it is a series or a movie', async () => {
    const old = await call('POST', '/api/v1/backfill/series', {
      serverId: 0,
      sonarrSeriesId: 1279,
    });
    assert.equal(old.status, 400);
    const res = await call('POST', '/api/v1/backfill/series', {
      kind: 'series',
      serverId: 0,
      arrId: 1279,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.kind, 'series');
    assert.equal(res.body.arrId, 1279);
  });

  it('show downloads as the client has them now, and import as soon as one is done', async () => {
    const { series, candidate } = await seed();
    const approved = await call(
      'POST',
      `/api/v1/backfill/candidates/${candidate.id}/approve`,
      { mode: 'all', confirm: 'kitsuraga' }
    );
    const id = approved.body.id;
    const saved = await getRepository(BackfillJob).findOneOrFail({
      where: { id },
    });
    let have = [1, 0.5];
    mock.method(QBittorrentAPI.prototype, 'getFiles', async () =>
      INFO.files.map((f, index) => ({
        index,
        name: [INFO.name, ...f.path].join('/'),
        size: f.length,
        progress: have[index] ?? 0,
        priority: index < 2 ? 1 : 0,
      }))
    );
    const size = INFO.files[0].length + INFO.files[1].length;
    const left = Math.round(INFO.files[1].length / 2);
    const expected = Math.floor(((size - left) / size) * 100);
    assert.notEqual(saved.progress, expected, 'nothing read yet');

    const detail = await call('GET', `/api/v1/backfill/jobs/${id}`);
    assert.equal(detail.body.progress, expected);
    assert.equal(detail.body.sizeLeft, left);
    assert.equal(detail.body.speed, 1000);
    assert.equal(detail.body.secondsLeft, 60);
    assert.equal(detail.body.stage, 'Downloading');
    const overview = await call('GET', '/api/v1/backfill');
    assert.equal(overview.body.jobs[0].progress, expected);
    const lookup = await call('GET', '/api/v1/backfill/lookup?tmdbIds=58371');
    assert.equal(lookup.body[0].job.progress, expected);
    assert.deepEqual(
      lookup.body[0].jobs.map((j: { id: number }) => j.id),
      [id]
    );
    // The page still shows the download when Sonarr cannot be reached.
    mock.method(backfill, 'context', async () => {
      throw new Error('Sonarr is down');
    });
    const review = await call('GET', `/api/v1/backfill/series/${series.id}`);
    assert.equal(review.body.arrError, 'Sonarr is down');
    assert.equal(review.body.jobs[0].progress, expected);
    // Read, not saved: the tick keeps the record.
    assert.equal(
      (await getRepository(BackfillJob).findOneOrFail({ where: { id } }))
        .progress,
      saved.progress
    );

    // Done: handed to Sonarr now, not at the next minute.
    have = [1, 1];
    torrentDone = true;
    const done = await call('GET', `/api/v1/backfill/jobs/${id}`);
    assert.equal(done.body.progress, 100);
    await new Promise((resolve) => setImmediate(resolve));
    await backfill.tickDone();
    assert.equal(
      (await getRepository(BackfillJob).findOneOrFail({ where: { id } }))
        .status,
      'importing'
    );
    assert.equal(imports.length, 1);
  });

  it('report what Backfill has for a title, for its page and the requests list', async () => {
    const { series } = await seed();
    const res = await call('GET', '/api/v1/backfill/lookup?tmdbIds=58371,1');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].id, series.id);
    assert.equal(res.body[0].kind, 'series');
    assert.equal(res.body[0].readyCount, 1);
    assert.deepEqual(res.body[0].jobs, []);
    assert.equal(res.body[0].workingRunId, null);

    // The admin agent at work on it: its conversation, for the page.
    const run = await getRepository(AgentRun).save(
      new AgentRun({
        trigger: 'auto',
        status: 'running',
        kind: 'series',
        serverId: series.serverId,
        arrId: series.arrId,
        steps: [],
        actions: [],
      })
    );
    const working = await call('GET', '/api/v1/backfill/lookup?tmdbIds=58371');
    assert.equal(working.body[0].workingRunId, run.id);
  });

  it('link a complete title from its page only when asked to', async () => {
    const { series } = await seed();
    await getRepository(BackfillSeries).update(series.id, { status: 'done' });
    const plain = await call('GET', '/api/v1/backfill/lookup?tmdbIds=58371');
    assert.deepEqual(plain.body, []);
    const all = await call(
      'GET',
      '/api/v1/backfill/lookup?tmdbIds=58371&all=true'
    );
    assert.equal(all.body.length, 1);
    assert.equal(all.body[0].status, 'done');
  });

  it('find an album by its MusicBrainz id, not by a TMDB id', async () => {
    await seed();
    const album = await getRepository(BackfillSeries).save(
      new BackfillSeries({
        kind: 'album',
        serverId: 0,
        arrId: 77,
        foreignId: '8a6b2d3c-1111-4222-8333-944455556666',
        artistName: 'Paper Lanterns',
        artistArrId: 12,
        title: 'Glasswing',
        year: 2019,
        status: 'stuck',
        missing: 4,
        searchTerms: [],
      })
    );
    const byMbid = await call(
      'GET',
      `/api/v1/backfill/lookup?mbIds=${album.foreignId}`
    );
    assert.equal(byMbid.status, 200, JSON.stringify(byMbid.body));
    assert.deepEqual(
      byMbid.body.map((row: { id: number }) => row.id),
      [album.id]
    );
    assert.equal(byMbid.body[0].kind, 'album');
    assert.equal(byMbid.body[0].foreignId, album.foreignId);
    const byTmdb = await call('GET', '/api/v1/backfill/lookup?tmdbIds=58371');
    assert.deepEqual(
      byTmdb.body.map((row: { kind: string }) => row.kind),
      ['series']
    );
  });

  it('list the albums Lidarr monitors for starting a search, while Backfill does music', async () => {
    const settings = getSettings();
    settings.backfill = { ...settings.backfill, includeMusic: true };
    settings.lidarr = [
      {
        id: 3,
        name: 'Lidarr',
        hostname: 'lidarr',
        port: 8686,
        apiKey: 'x',
        useSsl: false,
        isDefault: true,
      } as unknown as LidarrSettings,
    ];
    settings.main.disabledFeatures = [];
    try {
      mock.method(BackfillSonarr.prototype, 'getAllSeries', async () => [
        { id: 1279, title: 'Kitsuraga', year: 2002, tvdbId: 63914 },
      ]);
      const forServer = BackfillLidarr.forServer;
      mock.method(BackfillLidarr, 'forServer', (server: LidarrSettings) =>
        Object.assign(forServer.call(BackfillLidarr, server), {
          getAlbums: async () => [
            {
              id: 77,
              title: 'Glasswing',
              foreignAlbumId: '8a6b2d3c-1111-4222-8333-944455556666',
              artistId: 12,
              monitored: true,
              releaseDate: '2019-04-05T00:00:00Z',
            },
            {
              id: 78,
              title: 'Unwanted Live',
              foreignAlbumId: '8a6b2d3c-1111-4222-8333-944455556667',
              artistId: 12,
              monitored: false,
            },
          ],
          getArtists: async () => [{ id: 12, artistName: 'Paper Lanterns' }],
        })
      );
      const res = await call('GET', '/api/v1/backfill/library');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(
        res.body.map((o: { kind: string; title: string }) => [o.kind, o.title]),
        [
          ['album', 'Glasswing'],
          ['series', 'Kitsuraga'],
        ]
      );
      const album = res.body.find((o: { kind: string }) => o.kind === 'album');
      assert.equal(album.artist, 'Paper Lanterns');
      assert.equal(album.year, 2019);
      assert.equal(album.arrId, 77);

      settings.backfill = { ...settings.backfill, includeMusic: false };
      const off = await call('GET', '/api/v1/backfill/library');
      assert.deepEqual(
        off.body.map((o: { kind: string }) => o.kind),
        ['series']
      );
    } finally {
      settings.lidarr = [];
    }
  });

  it('find an album in Lidarr for its page only while Backfill does music', async () => {
    const mbId = '8a6b2d3c-1111-4222-8333-944455556666';
    const settings = getSettings();
    settings.backfill = { ...settings.backfill, includeMusic: false };
    settings.lidarr = [
      {
        id: 3,
        name: 'Lidarr',
        hostname: 'lidarr',
        port: 8686,
        apiKey: 'x',
        useSsl: false,
        isDefault: true,
      } as unknown as LidarrSettings,
    ];
    settings.main.disabledFeatures = [];
    try {
      mock.method(
        BackfillLidarr.prototype,
        'getAlbumByMbid',
        async (id: string) =>
          id === mbId ? { id: 77, title: 'Glasswing' } : undefined
      );
      const off = await call('GET', `/api/v1/backfill/album/${mbId}`);
      assert.equal(off.status, 404);

      settings.backfill = { ...settings.backfill, includeMusic: true };
      const found = await call(
        'GET',
        `/api/v1/backfill/album/${mbId}?serverId=3`
      );
      assert.equal(found.status, 200, JSON.stringify(found.body));
      assert.deepEqual(found.body, {
        kind: 'album',
        serverId: 3,
        arrId: 77,
        title: 'Glasswing',
      });
      const missing = await call(
        'GET',
        '/api/v1/backfill/album/00000000-0000-4000-8000-000000000000'
      );
      assert.equal(missing.status, 404);
    } finally {
      settings.lidarr = [];
    }
  });

  it('search the titles by any part of the name, and count matches per tab', async () => {
    await seed();
    const more = (title: string, arrId: number, status: string) =>
      new BackfillSeries({
        serverId: 0,
        arrId,
        title,
        status: status as BackfillSeries['status'],
        missing: 1,
        searchTerms: [],
      });
    await getRepository(BackfillSeries).save([
      more('Kitsuraga Tsumuden', 2, 'stuck'),
      more('Sorato: Kitsuraga Next Lanterns', 3, 'done'),
      more('Inkwash', 4, 'stuck'),
      more('100% Wombat', 5, 'ignored'),
    ]);
    const stuck = await call('GET', '/api/v1/backfill?q=KITSURAGA');
    assert.equal(stuck.status, 200, JSON.stringify(stuck.body));
    assert.deepEqual(
      stuck.body.series.map((s: { title: string }) => s.title).sort(),
      ['Kitsuraga', 'Kitsuraga Tsumuden']
    );
    assert.deepEqual(stuck.body.counts, {
      all: 2,
      found: 1,
      ignored: 0,
      done: 1,
    });
    // What the page shows above the list stays the whole picture.
    assert.equal(stuck.body.stats.stuck, 3);

    const done = await call('GET', '/api/v1/backfill?filter=done&q=kitsuraga');
    assert.deepEqual(
      done.body.series.map((s: { title: string }) => s.title),
      ['Sorato: Kitsuraga Next Lanterns']
    );
    // A % is a percent sign, not "anything".
    const percent = await call(
      'GET',
      `/api/v1/backfill?filter=ignored&q=${encodeURIComponent('0% w')}`
    );
    assert.deepEqual(
      percent.body.series.map((s: { title: string }) => s.title),
      ['100% Wombat']
    );
    const wild = await call(
      'GET',
      `/api/v1/backfill?q=${encodeURIComponent('%')}`
    );
    assert.deepEqual(wild.body.series, []);
    assert.equal(wild.body.counts.ignored, 1);
  });
});

describe('Backfill: stalled downloads, and the AI second opinion end to end', () => {
  it('gives up on a torrent that gains nothing, and offers the next pack', async () => {
    // Replacing on its own is off, and the next pack is not good enough
    // for it anyway.
    getSettings().backfill = {
      ...getSettings().backfill,
      replaceFailed: false,
    };
    const { series, candidate } = await seed();
    const next = await getRepository(BackfillCandidate).save(
      new BackfillCandidate({
        seriesId: series.id,
        guid: 'https://indexer/2',
        title: '[Other] Kitsuraga 101-102 [1080p]',
        indexer: 'Nyaa',
        indexerId: 3,
        protocol: 'torrent',
        size: 700,
        seeders: 40,
        status: 'ready',
        plan: [entry(0, 'n.mkv', 101, 'fill', 0)],
        summary: {
          fill: 1,
          upgrade: 0,
          skip: 0,
          reject: 0,
          covered: 1,
          bytes: 400,
          fillBytes: 400,
          replaces: 0,
          quality: 'WEBDL-1080p',
          score: 300,
        },
      })
    );
    const res = await call(
      'POST',
      `/api/v1/backfill/candidates/${candidate.id}/approve`,
      { mode: 'missing' }
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));

    let now = Date.now();
    const clock = mock.method(Date, 'now', () => now);
    await backfill.tick();
    now += 11 * 60 * 60_000;
    await backfill.tick();
    const jobs = getRepository(BackfillJob);
    assert.equal(
      (await jobs.findOneOrFail({ where: { id: res.body.id } })).status,
      'downloading',
      'eleven hours is inside the twelve allowed'
    );

    now += 2 * 60 * 60_000;
    await backfill.tick();
    const job = await jobs.findOneOrFail({ where: { id: res.body.id } });
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /^Nothing downloaded for 12 hours/);
    assert.deepEqual(deleted, [HASH], 'the dead torrent is removed');
    const failed = await getRepository(BackfillCandidate).findOneOrFail({
      where: { id: candidate.id },
    });
    assert.equal(failed.status, 'dead');
    assert.equal(
      (
        await getRepository(BackfillSeries).findOneOrFail({
          where: { id: series.id },
        })
      ).status,
      'found'
    );
    backfillNotices.flush();
    const offered = sent.filter(
      (s) => s.payload.actionUrl === `/backfill/series/${series.id}`
    );
    assert.equal(offered.length, 1);
    assert.match(offered[0].payload.message ?? '', /\[Other\] Kitsuraga/);
    assert.equal(
      (
        await getRepository(BackfillCandidate).findOneOrFail({
          where: { id: next.id },
        })
      ).notifiedAt instanceof Date,
      true
    );

    // The failed download's page says what became of it, and so does the
    // title's list of backfills.
    const page = await call('GET', `/api/v1/backfill/jobs/${job.id}`);
    assert.equal(page.status, 200);
    assert.equal(page.body.followUp, 'offered');
    assert.equal(page.body.replacedById, null);
    // Once an admin takes the pack offered, it is what replaced it.
    clock.mock.restore();
    const taken = await call(
      'POST',
      `/api/v1/backfill/candidates/${next.id}/approve`,
      { mode: 'missing' }
    );
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    const replaced = await jobs.findOneOrFail({ where: { id: job.id } });
    assert.equal(replaced.followUp, 'replaced');
    assert.equal(replaced.replacedById, taken.body.id);
  });

  it('does not count time a torrent is paused or queued in qBittorrent as stalling', async () => {
    getSettings().backfill = {
      ...getSettings().backfill,
      replaceFailed: false,
    };
    const { candidate } = await seed();
    const res = await call(
      'POST',
      `/api/v1/backfill/candidates/${candidate.id}/approve`,
      { mode: 'missing' }
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let now = Date.now();
    mock.method(Date, 'now', () => now);
    const jobs = getRepository(BackfillJob);
    const status = async () =>
      (await jobs.findOneOrFail({ where: { id: res.body.id } })).status;

    await backfill.tick();
    // Queued behind qBittorrent's own limit, then paused, for a day.
    for (const state of ['queuedDL', 'stoppedDL']) {
      torrentState = state;
      now += 13 * 60 * 60_000;
      await backfill.tick();
      assert.equal(await status(), 'downloading', `${state} is not a stall`);
    }
    assert.equal(
      (await jobs.findOneOrFail({ where: { id: res.body.id } })).stage,
      'Paused in qBittorrent'
    );
    // Back to downloading: the clock starts from there, not from before.
    torrentState = 'stalledDL';
    now += 60_000;
    await backfill.tick();
    assert.equal(await status(), 'downloading');
    now += 13 * 60 * 60_000;
    await backfill.tick();
    assert.equal(await status(), 'failed', 'stalled while meant to download');
  });

  it('downloads the next good pack in place of one that stalled', async () => {
    const { series, candidate } = await seed();
    const next = await getRepository(BackfillCandidate).save(
      new BackfillCandidate({
        seriesId: series.id,
        guid: 'https://indexer/2',
        title: '[Other] Kitsuraga 101-102 [1080p]',
        indexer: 'Nyaa',
        indexerId: 3,
        protocol: 'torrent',
        size: 700,
        seeders: 40,
        status: 'ready',
        plan: [entry(0, 'n.mkv', 101, 'fill', 0)],
        summary: {
          fill: 1,
          upgrade: 0,
          skip: 0,
          reject: 0,
          covered: 1,
          bytes: 400,
          fillBytes: 400,
          replaces: 0,
          quality: 'Bluray-1080p',
          score: 700,
        },
      })
    );
    const searched = mock.method(backfill, 'search', async () => undefined);
    const res = await call(
      'POST',
      `/api/v1/backfill/candidates/${candidate.id}/approve`,
      { mode: 'missing' }
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let now = Date.now();
    mock.method(Date, 'now', () => now);
    await backfill.tick();
    now += 13 * 60 * 60_000;
    await backfill.tick();

    const jobs = getRepository(BackfillJob);
    const failed = await jobs.findOneOrFail({ where: { id: res.body.id } });
    assert.equal(failed.status, 'failed');
    const replacement = await jobs.findOneOrFail({
      where: { candidateId: next.id },
    });
    assert.match(
      failed.log.at(-1)?.message ?? '',
      new RegExp(`^Replaced by #${replacement.id}: \\[Other\\] Kitsuraga`)
    );
    assert.equal(replacement.status, 'downloading');
    assert.equal(
      replacement.approvedByName,
      `Backfill (replacing #${failed.id})`
    );
    assert.equal(failed.followUp, 'replaced');
    assert.equal(failed.replacedById, replacement.id);
    const page = await call('GET', `/api/v1/backfill/jobs/${failed.id}`);
    assert.equal(page.body.followUp, 'replaced');
    assert.equal(page.body.replacedById, replacement.id);
    assert.deepEqual(
      replacement.files.map((f) => f.episodeIds),
      [[101]]
    );
    backfillNotices.flush();
    assert.equal(searched.mock.callCount(), 0, 'no new search was needed');
    assert.equal(
      sent.filter(
        (s) => s.payload.actionUrl === `/backfill/series/${series.id}`
      ).length,
      0,
      'nothing was offered to an admin'
    );
  });

  it('clears magnet probes left in qBittorrent, and nothing else', async () => {
    const { candidate } = await seed();
    const res = await call(
      'POST',
      `/api/v1/backfill/candidates/${candidate.id}/approve`,
      { mode: 'missing' }
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let now = Date.now();
    mock.method(Date, 'now', () => now);
    const added = (min: number) => Math.floor((now - min * 60_000) / 1000);
    mock.method(QBittorrentAPI.prototype, 'getCategoryTorrents', async () => [
      { hash: HASH, progress: 0, added_on: added(60) },
      { hash: 'old-probe', progress: 0, added_on: added(60) },
      { hash: 'new-probe', progress: 0, added_on: added(2) },
      { hash: 'someone-elses', progress: 0.4, added_on: added(60) },
    ]);
    now += 11 * 60_000;
    await backfill.tick();
    assert.deepEqual(deleted, ['old-probe']);
    // Not again until ten minutes on.
    await backfill.tick();
    assert.deepEqual(deleted, ['old-probe']);
  });

  it('say when a download waiting on its indexer’s limit is tried again', async () => {
    const { series } = await seed();
    const until = new Date(Date.now() + 20 * 60_000).toISOString();
    const waiting = await getRepository(BackfillJob).save(
      new BackfillJob({
        seriesId: series.id,
        candidateId: null,
        title: 'A pack',
        status: 'queued',
        stage: 'Tabula Rasa has reached its download limit',
        mode: 'missing',
        protocol: 'usenet',
        clientId: 2,
        downloadId: null,
        files: [{ ...PLAN[0], state: 'waiting' }],
        size: 400,
        sizeLeft: 400,
        commandIds: [],
        log: [
          {
            at: new Date().toISOString(),
            kind: 'warn',
            message: 'Tabula Rasa has reached its download limit',
            count: 3,
            lastAt: new Date().toISOString(),
          },
        ],
        indexerWait: {
          indexer: 'Tabula Rasa',
          indexerId: 7,
          since: new Date().toISOString(),
          until,
          strikes: 3,
        },
      })
    );
    const detail = await call('GET', `/api/v1/backfill/jobs/${waiting.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.retryAt, until);
    assert.equal(detail.body.log[0].count, 3);
    // Once the wait is over, there is no time to give.
    await getRepository(BackfillJob).update(waiting.id, {
      indexerWait: {
        indexer: 'Tabula Rasa',
        indexerId: 7,
        since: new Date().toISOString(),
        until: new Date(Date.now() - 60_000).toISOString(),
        strikes: 3,
      },
    });
    const over = await call('GET', `/api/v1/backfill/jobs/${waiting.id}`);
    assert.equal(over.body.retryAt, null);
  });

  it('say which admin agent conversation looks for another release after its download failed', async () => {
    const { series } = await seed();
    const failed = await getRepository(BackfillJob).save(
      new BackfillJob({
        seriesId: series.id,
        candidateId: null,
        title: 'Kitsuraga.S03E06.x264-KILN',
        status: 'failed',
        protocol: 'usenet',
        clientId: 2,
        files: [{ ...PLAN[0], state: 'waiting' }],
        error: 'SABnzbd could not finish it: Aborted, cannot be completed',
        approvedByName: 'AI agent',
        agentRunId: 37,
        followUp: 'agent',
        finishedAt: new Date(),
      })
    );
    const detail = await call('GET', `/api/v1/backfill/jobs/${failed.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.followUp, 'agent');
    assert.equal(detail.body.agentRunId, 37);
    assert.equal(detail.body.replacedById, null);
    // The title's list of backfills says it too (Sonarr left out of it).
    mock.method(backfill, 'context', async () => {
      throw new Error('Sonarr is down');
    });
    const title = await call('GET', `/api/v1/backfill/series/${series.id}`);
    assert.equal(title.status, 200);
    assert.deepEqual(
      (
        title.body.jobs as {
          id: number;
          followUp: string;
          agentRunId: number;
        }[]
      ).map((j) => [j.id, j.followUp, j.agentRunId]),
      [[failed.id, 'agent', 37]]
    );
  });

  it('run a second download for other episodes, leaving out what one already fetches', async () => {
    const { series, candidate } = await seed();
    const running = await getRepository(BackfillJob).save(
      new BackfillJob({
        seriesId: series.id,
        candidateId: null,
        title: 'Another pack',
        status: 'downloading',
        mode: 'missing',
        protocol: 'torrent',
        clientId: 1,
        downloadId: 'feed',
        files: [{ ...PLAN[0], state: 'waiting' }],
        size: 400,
        sizeLeft: 400,
        commandIds: [],
        log: [],
      })
    );
    const res = await call(
      'POST',
      `/api/v1/backfill/candidates/${candidate.id}/approve`,
      { mode: 'all', confirm: 'kitsuraga' }
    );
    assert.equal(res.status, 200, res.body.message);
    const job = await getRepository(BackfillJob).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.notEqual(job.id, running.id);
    // S03E06 is the other download's; this one takes only S03E07.
    assert.deepEqual(
      job.files.map((f) => f.episodeIds),
      [[102]]
    );
    assert.match(
      job.log[0].message,
      new RegExp(`left out 1 already downloading in #${running.id}`)
    );

    // A pack with nothing the running download does not already fetch.
    const again = await getRepository(BackfillCandidate).save(
      new BackfillCandidate({
        ...candidate,
        id: undefined,
        guid: 'https://indexer/2',
        status: 'ready',
        plan: [PLAN[0]],
      })
    );
    const refused = await call(
      'POST',
      `/api/v1/backfill/candidates/${again.id}/approve`,
      { mode: 'missing' }
    );
    assert.equal(refused.status, 400);
    assert.equal(
      refused.body.message,
      `Everything in this pack is already downloading in Backfill #${running.id}.`
    );

    // Ending one leaves the title downloading while the other runs.
    const ended = await call('POST', `/api/v1/backfill/jobs/${running.id}/end`);
    assert.equal(ended.status, 200, ended.body.message);
    assert.equal(
      (
        await getRepository(BackfillSeries).findOneOrFail({
          where: { id: series.id },
        })
      ).status,
      'downloading'
    );
  });

  it('approves without the files only the AI placed, when told to', async () => {
    const { candidate } = await seed();
    await getRepository(BackfillCandidate).update(candidate.id, {
      plan: [
        PLAN[0],
        {
          ...entry(1, 'Special.mkv', 102, 'fill', 0),
          matchedBy: 'ai',
          why: 'Named after the special',
        },
      ],
    });
    const res = await call(
      'POST',
      `/api/v1/backfill/candidates/${candidate.id}/approve`,
      { mode: 'missing', includeAi: false }
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const job = await getRepository(BackfillJob).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.deepEqual(
      job.files.map((f) => f.index),
      [0]
    );
  });

  it('asks the model about the file named only by its title, and never auto-approves it', async () => {
    const SPECIAL_INFO = {
      name: '[Tengu] Kitsuraga (Complete Series)',
      'piece length': 4194304,
      pieces: Buffer.alloc(20),
      files: [
        {
          length: 476_000_000,
          path: ['S5', '[Tengu] Kitsuraga - S05E17 (202).mkv'],
        },
        {
          length: 300_000_000,
          path: [
            'Specials',
            '[Tengu] Kitsuraga - Misty Pine Village Grand Sports Festival.mkv',
          ],
        },
      ],
    };
    torrentData = ben({ announce: 'udp://tracker', info: SPECIAL_INFO });
    const PACK =
      '[Tengu] Kitsuraga (Complete Series) [BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]';
    const ep202 = {
      ...ep(145136, false),
      seasonNumber: 5,
      episodeNumber: 23,
      absoluteEpisodeNumber: 202,
      title: 'The Battle Begins: Kitsuraga vs. Ryomaru',
    };
    const festival = {
      ...ep(145157, false),
      seasonNumber: 0,
      episodeNumber: 3,
      absoluteEpisodeNumber: undefined,
      title: 'Kitsuraga OVA 3: Misty Pine Village Grand Sports Festival',
    };
    episodes = [ep202, festival];
    const bd = {
      quality: { id: 7, name: 'Bluray-1080p' },
      revision: { version: 1, real: 0 },
    };
    // What Sonarr answered on the live server for these names.
    const parsed: Record<string, unknown> = {
      '[Tengu] Kitsuraga - S05E17 (202)': {
        title: '',
        parsedEpisodeInfo: {
          seriesTitle: 'Kitsuraga',
          seasonNumber: 5,
          episodeNumbers: [17],
        },
        series: { id: 1279, title: 'Kitsuraga' },
        episodes: [],
      },
      [`[Tengu] Kitsuraga - 202 [BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]`]:
        {
          title: '',
          parsedEpisodeInfo: {
            seriesTitle: 'Kitsuraga',
            quality: bd,
            absoluteEpisodeNumbers: [202],
            releaseGroup: 'Tengu',
          },
          series: { id: 1279, title: 'Kitsuraga' },
          episodes: [ep202],
          customFormatScore: 700,
        },
      [`[Tengu] Kitsuraga - S00E03 [BD 1080p][HEVC x265 10bit][Multi-Audio][Multi-Subs]`]:
        {
          title: '',
          parsedEpisodeInfo: {
            seriesTitle: 'Kitsuraga',
            quality: bd,
            seasonNumber: 0,
            episodeNumbers: [3],
            releaseGroup: 'Tengu',
          },
          series: { id: 1279, title: 'Kitsuraga' },
          episodes: [festival],
          customFormatScore: 700,
        },
    };
    mock.method(BackfillSonarr.prototype, 'parse', async (title: string) => ({
      title,
      customFormatScore: 0,
      ...((parsed[title] as object) ?? {}),
    }));
    mock.method(BackfillSonarr.prototype, 'getEpisodeFiles', async () => []);
    mock.method(BackfillSonarr.prototype, 'getQualityProfile', async () => ({
      id: 13,
      name: 'Anime 1080p',
      upgradeAllowed: true,
      cutoff: 7,
      minFormatScore: 100,
      cutoffFormatScore: 10000,
      minUpgradeFormatScore: 1,
      items: [{ quality: { id: 7, name: 'Bluray-1080p' }, allowed: true }],
    }));
    mock.method(ProwlarrAPI.prototype, 'search', async () => [
      {
        guid: 'https://nyaa/tengu',
        title: PACK,
        size: 776_000_000,
        indexerId: 1,
        indexer: 'Nyaa',
        protocol: 'torrent',
        seeders: 211,
        downloadUrl: 'http://prowlarr:9696/1/download?apikey=k',
      },
    ]);
    // The model, stubbed at its HTTP call.
    const prompts: string[] = [];
    mock.method(
      axios,
      'post',
      async (_url: string, body: { messages: { content: string }[] }) => {
        prompts.push(body.messages[0].content);
        const line = body.messages[0].content
          .split('\n')
          .find((l) => l.includes('Sports Festival"'))!;
        const n = Number(line.match(/^e(\d+):/)![1]);
        return {
          data: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  m: [{ f: 1, e: [n], w: 'Title is OVA 3' }],
                }),
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        };
      }
    );
    getSettings().ai = {
      enabled: true,
      provider: 'anthropic',
      apiKey: 'test-key',
      baseUrl: '',
      model: 'claude-test',
      featureModels: {},
      dailyLimit: 0,
    };
    getSettings().backfill.autoApprove = {
      enabled: true,
      minScore: 0,
      maxSizeGb: 1000,
    };

    const series = await getRepository(BackfillSeries).save(
      new BackfillSeries({
        serverId: 0,
        arrId: 1279,
        title: 'Kitsuraga',
        seriesType: 'anime',
        status: 'stuck',
        missing: 1,
        searchTerms: [],
      })
    );
    await backfill.search(series.id, admin, { ai: true });

    assert.equal(prompts.length, 1, 'one question, about one pack');
    assert.match(prompts[0], /Misty Pine Village Grand Sports Festival/);
    assert.match(prompts[0], /^1\. \[Tengu\] Kitsuraga - Misty Pine/m);
    assert.ok(
      !prompts[0].includes('apikey'),
      'Prowlarr links never reach the model'
    );
    const found = await getRepository(BackfillCandidate).findOneOrFail({
      where: { seriesId: series.id },
    });
    assert.equal(found.status, 'ready', found.reason ?? '');
    const ai = found.plan.find((e) => e.matchedBy === 'ai');
    assert.ok(ai, 'the special is placed');
    assert.deepEqual(ai.episodeIds, [145157]);
    assert.equal(ai.why, 'Title is OVA 3');
    assert.equal(found.summary?.aiMatched, 1);
    assert.equal(
      await getRepository(BackfillJob).count({
        where: { seriesId: series.id },
      }),
      0,
      'auto-approve leaves a pack with AI matches for an admin'
    );
    backfillNotices.flush();
    assert.ok(
      sent.some((s) => s.payload.actionUrl === `/backfill/series/${series.id}`),
      'admins are asked instead'
    );
  });
});
