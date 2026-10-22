import SabnzbdAPI from '@server/api/downloadclients/sabnzbd';
import type { ProwlarrRelease } from '@server/api/prowlarr';
import ProwlarrAPI from '@server/api/prowlarr';
import dataSource, { getRepository } from '@server/datasource';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import type { User } from '@server/entity/User';
import backfill, { plainProblem } from '@server/lib/backfill/engine';
import {
  backoffMs,
  IndexerLimitReached,
  indexerLimits,
  limitOf,
  retryAfterOf,
} from '@server/lib/backfill/indexerLimit';
import type { Notice } from '@server/lib/backfill/notices';
import backfillNotices from '@server/lib/backfill/notices';
import type { PlanEntry } from '@server/lib/backfill/plan';
import { summarize } from '@server/lib/backfill/plan';
import type { SonarrEpisode } from '@server/lib/backfill/sonarr';
import BackfillSonarr from '@server/lib/backfill/sonarr';
import notificationManager from '@server/lib/notifications';
import type { SonarrSettings } from '@server/lib/settings';
import { BACKFILL_DEFAULTS, getSettings } from '@server/lib/settings';
import { AddBackfillIndexerWait1795000000000 as PostgresMigration } from '@server/migration/postgres/1795000000000-AddBackfillIndexerWait';
import { AddBackfillIndexerWait1795000000000 as SqliteMigration } from '@server/migration/sqlite/1795000000000-AddBackfillIndexerWait';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import { AxiosError, AxiosHeaders } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

setupTestDb();

/*
 * An indexer's download limit, as Tabula Rasa's was reached on a real
 * server: a Usenet pack for two missing TruthTesters episodes, whose NZB
 * Prowlarr could not hand over ("Request failed with status code 429").
 * Backfill tried again every minute, gave the job up after ten, offered
 * the pack again, and it was approved again: all day. Prowlarr, Sonarr and
 * SABnzbd are stubbed at their API clients; time is the mocked clock.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const ep = (id: number, episode: number): SonarrEpisode => ({
  id,
  seriesId: 123,
  seasonNumber: 2016,
  episodeNumber: episode,
  hasFile: false,
  monitored: true,
  episodeFileId: 0,
  airDateUtc: '2016-01-01T00:00:00Z',
});

const entry = (index: number, episodeId: number): PlanEntry => ({
  index,
  path: `TruthTesters.S2016E0${index + 1}.1080p.AMZN.mkv`,
  size: 2e9,
  judgedAs: `TruthTesters.S2016E0${index + 1}.1080p.AMZN.mkv`,
  episodeIds: [episodeId],
  season: 2016,
  episode: index + 1,
  score: 900,
  action: 'fill',
  replaces: 0,
});
const PLAN = [entry(0, 501), entry(1, 502)];

const RELEASE: ProwlarrRelease = {
  guid: 'https://prowlarr/7/truthtesters',
  title: 'TruthTesters.S2016E01.1080p.AMZN.WEB-DL',
  size: 4e9,
  indexerId: 7,
  indexer: 'Tabula Rasa',
  protocol: 'usenet',
  downloadUrl: 'http://prowlarr:9696/7/download?link=x',
};

const gm = { id: 1, displayName: 'Sam' } as User;

/** An answer Prowlarr gives, as axios throws it. */
const answered = (status: number, headers: Record<string, string> = {}) =>
  new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_REQUEST',
    { headers: new AxiosHeaders(), url: RELEASE.downloadUrl },
    undefined,
    {
      status,
      statusText: '',
      headers,
      config: { headers: new AxiosHeaders() },
      data: undefined,
    }
  );

/** No answer at all from an app, as axios throws it. */
const unanswered = (url: string) =>
  new AxiosError(`connect ECONNREFUSED ${url}`, 'ECONNREFUSED', {
    headers: new AxiosHeaders(),
    url,
  });

let now = 0;
let fetches = 0;
let diskChecks = 0;
let fetchFails: () => unknown = () => answered(429);
let added: string[] = [];
let notices: Notice[] = [];

const setTime = (ms: number) => {
  now = ms;
  mock.timers.setTime(now);
};

/** Minute ticks for a while, as the scheduled job runs them. */
const ticks = async (minutes: number, every?: () => Promise<void>) => {
  for (let i = 1; i <= minutes; i++) {
    setTime(now + MINUTE);
    await backfill.tick();
    if (every && i % 60 === 0) await every();
  }
};

beforeEach(() => {
  now = Date.parse('2026-10-14T22:45:00Z');
  mock.timers.enable({ apis: ['Date'], now });
  indexerLimits.reset();
  fetches = 0;
  diskChecks = 0;
  added = [];
  notices = [];
  fetchFails = () => answered(429);
  const settings = getSettings();
  settings.backfill = {
    ...BACKFILL_DEFAULTS,
    enabled: true,
    prowlarr: {
      ...BACKFILL_DEFAULTS.prowlarr,
      hostname: 'prowlarr',
      apiKey: 'k',
    },
    usenetClientId: 2,
    includeMovies: false,
    autoApprove: { enabled: true, minScore: 0, maxSizeGb: 100 },
  };
  settings.radarr = [];
  settings.sonarr = [
    {
      id: 0,
      name: 'Sonarr',
      hostname: 'sonarr',
      port: 8989,
      apiKey: 'x',
      useSsl: false,
      is4k: false,
    } as unknown as SonarrSettings,
  ];
  settings.downloadClients = [
    {
      id: 2,
      name: 'SABnzbd',
      type: 'sabnzbd',
      hostname: 'sabnzbd',
      port: 8080,
      useSsl: false,
      urlBase: '',
      apiKey: 's',
      username: '',
      password: '',
    },
  ];
  mock.method(notificationManager, 'sendNotification', () => undefined);
  const add = backfillNotices.add.bind(backfillNotices);
  mock.method(backfillNotices, 'add', (notice: Notice) => {
    notices.push(notice);
    add(notice);
  });
  const sonarr = BackfillSonarr.prototype;
  mock.method(sonarr, 'getSeriesEpisodes', async () => [
    ep(501, 1),
    ep(502, 2),
  ]);
  mock.method(sonarr, 'getSeriesDetail', async () => ({
    id: 123,
    title: 'TruthTesters',
    path: '/tv/TruthTesters',
    seriesType: 'standard',
    qualityProfileId: 1,
  }));
  mock.method(sonarr, 'getRootFoldersNow', async () => {
    diskChecks += 1;
    return [{ path: '/tv', freeSpace: 5e13 }];
  });
  // A wanted list cut short: the scan leaves the titles as they are.
  mock.method(sonarr, 'getWanted', async () => ({
    records: [],
    complete: false,
  }));
  mock.method(ProwlarrAPI.prototype, 'search', async () => [RELEASE]);
  mock.method(ProwlarrAPI.prototype, 'fetchRelease', async () => {
    fetches += 1;
    const problem = fetchFails();
    if (problem) throw problem;
    return { kind: 'nzb', data: Buffer.from('<nzb></nzb>') };
  });
  mock.method(
    SabnzbdAPI.prototype,
    'addNzb',
    async (_nzb: Buffer, name: string) => {
      added.push(name);
      return `SABnzbd_nzo_${added.length}`;
    }
  );
  mock.method(SabnzbdAPI.prototype, 'getJob', async () => ({
    place: 'queue',
    status: 'Downloading',
    percentage: 0,
    size: RELEASE.size,
    sizeLeft: RELEASE.size,
  }));
  mock.method(SabnzbdAPI.prototype, 'deleteJob', async () => undefined);
  mock.method(SabnzbdAPI.prototype, 'pauseJob', async () => undefined);
});

afterEach(() => {
  backfillNotices.flush();
  mock.timers.reset();
  mock.restoreAll();
  indexerLimits.reset();
});

const seed = async (
  over: Partial<BackfillCandidate> = {},
  arrId = 123
): Promise<{ row: BackfillSeries; candidate: BackfillCandidate }> => {
  const row = await getRepository(BackfillSeries).save(
    new BackfillSeries({
      kind: 'series',
      serverId: 0,
      arrId,
      title: arrId === 123 ? 'TruthTesters' : `Series ${arrId}`,
      seriesType: 'standard',
      status: 'found',
      missing: 2,
      searchTerms: [],
    })
  );
  const candidate = await getRepository(BackfillCandidate).save(
    new BackfillCandidate({
      seriesId: row.id,
      guid: RELEASE.guid,
      title: RELEASE.title,
      indexer: RELEASE.indexer,
      indexerId: RELEASE.indexerId,
      protocol: 'usenet',
      size: RELEASE.size,
      downloadUrl: RELEASE.downloadUrl,
      status: 'ready',
      plan: PLAN,
      summary: summarize(PLAN),
      ...over,
    })
  );
  return { row, candidate };
};

const jobOf = (id: number) =>
  getRepository(BackfillJob).findOneOrFail({ where: { id } });

/** A search that finds the release again and judges it as before. */
const searchFindsItAgain = () =>
  mock.method(
    backfill as unknown as { target: () => Promise<unknown> },
    'target',
    async () => ({
      title: 'TruthTesters',
      poster: null,
      names: ['TruthTesters'],
      missing: 2,
      categories: [5000],
      extraTerms: [],
      wants: () => 1,
      readTitle: async () => ({ other: false, sees: true }),
      judge: async () => ({ plan: PLAN, summary: summarize(PLAN) }),
    })
  );

describe('an indexer’s limit, read from its answer', () => {
  it('honours Retry-After in seconds or as a date', () => {
    const at = Date.parse('2026-10-14T22:00:00Z');
    assert.equal(retryAfterOf('120', at), at + 120_000);
    assert.equal(
      retryAfterOf('Wed, 14 Oct 2026 23:10:00 GMT', at),
      Date.parse('2026-10-14T23:10:00Z')
    );
    assert.equal(retryAfterOf('Wed, 14 Oct 2026 21:00:00 GMT', at), undefined);
    assert.equal(retryAfterOf('soon', at), undefined);
    assert.deepEqual(limitOf(answered(429, { 'retry-after': '60' }), at), {
      until: at + 60_000,
    });
    assert.deepEqual(limitOf(answered(429), at), { until: undefined });
    // A 503 is a limit only when it says when to come back.
    assert.deepEqual(limitOf(answered(503, { 'retry-after': '30' }), at), {
      until: at + 30_000,
    });
    assert.equal(limitOf(answered(503), at), null);
    assert.equal(limitOf(answered(500), at), null);
    // Sonarr's and Radarr's own calls carry it as the cause.
    assert.deepEqual(
      limitOf(new Error('[Sonarr] failed', { cause: answered(429) }), at),
      { until: undefined }
    );
  });

  it('waits 15 minutes, then 30, an hour, two… and never more than six', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 12].map((n) => backoffMs(n) / MINUTE),
      [15, 30, 60, 120, 240, 360, 360, 360]
    );
  });
});

describe('Backfill and an indexer’s download limit', () => {
  it('keeps the job waiting, says until when, and asks nothing before then', async () => {
    const { candidate } = await seed();
    const job = await backfill.approve(candidate.id, {
      mode: 'missing',
      user: gm,
    });
    assert.equal(fetches, 1);
    let held = await jobOf(job.id);
    assert.equal(held.status, 'queued');
    assert.equal(held.stage, 'Tabula Rasa has reached its download limit');
    assert.equal(
      held.indexerWait?.until,
      new Date(now + 15 * MINUTE).toISOString()
    );
    assert.equal(held.indexerWait?.indexer, 'Tabula Rasa');

    // Nothing is asked of the indexer while it waits, nor of Sonarr.
    const checked = diskChecks;
    await ticks(14);
    assert.equal(fetches, 1);
    assert.equal(diskChecks, checked, 'no disk-space check while waiting');
    held = await jobOf(job.id);
    assert.equal(held.status, 'queued');

    // At 15 minutes it is asked once; still at its limit, the wait doubles.
    await ticks(1);
    assert.equal(fetches, 2);
    held = await jobOf(job.id);
    assert.equal(held.status, 'queued');
    assert.equal(
      held.indexerWait?.until,
      new Date(now + 30 * MINUTE).toISOString()
    );

    // Once it answers, the download starts as any other.
    fetchFails = () => undefined;
    await ticks(30);
    held = await jobOf(job.id);
    assert.equal(fetches, 3);
    assert.equal(held.status, 'downloading');
    assert.equal(held.indexerWait, null);
    assert.deepEqual(added, [RELEASE.title]);
  });

  it('waits as long as Retry-After says, in seconds or as a date', async () => {
    fetchFails = () => answered(429, { 'retry-after': '3600' });
    const { candidate } = await seed();
    const job = await backfill.approve(candidate.id, { mode: 'missing' });
    assert.equal(
      (await jobOf(job.id)).indexerWait?.until,
      new Date(now + HOUR).toISOString()
    );
    await ticks(59);
    assert.equal(fetches, 1);

    const reset = new Date(now + 5 * HOUR);
    fetchFails = () => answered(503, { 'retry-after': reset.toUTCString() });
    await ticks(1);
    assert.equal(fetches, 2);
    const held = await jobOf(job.id);
    assert.equal(held.status, 'queued');
    assert.equal(
      held.indexerWait?.until,
      new Date(Math.floor(reset.getTime() / 1000) * 1000).toISOString()
    );
  });

  it('makes other downloads from the same indexer wait too, without asking it', async () => {
    const { candidate } = await seed();
    const first = await backfill.approve(candidate.id, { mode: 'missing' });
    const { candidate: other } = await seed(
      { guid: 'https://prowlarr/7/other', title: 'Other.Show.S01E01.1080p' },
      124
    );
    const second = await backfill.approve(other.id, { mode: 'missing' });
    assert.equal(fetches, 1, 'the second never asked');
    const held = await jobOf(second.id);
    assert.equal(held.status, 'queued');
    assert.equal(held.stage, 'Tabula Rasa has reached its download limit');
    assert.equal(
      held.indexerWait?.until,
      (await jobOf(first.id)).indexerWait?.until
    );

    // A pack from another indexer is not held up.
    fetchFails = () => undefined;
    const { candidate: elsewhere } = await seed(
      {
        guid: 'https://prowlarr/9/x',
        title: 'Third.Show.S01E01.1080p',
        indexer: 'NZBgeek',
        indexerId: 9,
      },
      125
    );
    const third = await backfill.approve(elsewhere.id, { mode: 'missing' });
    assert.equal((await jobOf(third.id)).status, 'downloading');
  });

  it('keeps waiting after Seerr restarts, from what the job remembered', async () => {
    const { candidate } = await seed();
    const job = await backfill.approve(candidate.id, { mode: 'missing' });
    indexerLimits.reset();
    await ticks(10);
    assert.equal(fetches, 1);
    assert.equal((await jobOf(job.id)).status, 'queued');
  });

  it('writes a line that repeats once, counting the tries', async () => {
    const { candidate } = await seed();
    const job = await backfill.approve(candidate.id, { mode: 'missing' });
    // Tries at 15, 45 and 105 minutes.
    await ticks(110);
    assert.equal(fetches, 4);
    const log = (await jobOf(job.id)).log;
    const limits = log.filter((l) =>
      l.message.startsWith('Tabula Rasa has reached its download limit')
    );
    assert.equal(limits.length, 1);
    assert.equal(limits[0].count, 4);
    assert.equal(limits[0].lastAt, new Date(now - 5 * MINUTE).toISOString());
    assert.ok(!log.some((l) => /status code 429/.test(l.message)));
  });

  it('gives up after a day at the limit, leaving the pack for an admin', async () => {
    const { row, candidate } = await seed();
    const job = await backfill.approve(candidate.id, { mode: 'missing' });
    await ticks(24 * 60 + 2);
    const failed = await jobOf(job.id);
    assert.equal(failed.status, 'failed');
    assert.match(
      failed.error ?? '',
      /Tabula Rasa has been at its download limit for over a day/
    );
    // Asked at 0, 15 min, 45, 1 h 45, 3 h 45, 7 h 45, 13 h 45, 19 h 45.
    assert.equal(fetches, 8);
    const back = await getRepository(BackfillCandidate).findOneOrFail({
      where: { id: candidate.id },
    });
    assert.equal(back.status, 'ready', 'an admin can still approve it');
    assert.match(back.reason ?? '', /did not start.*approve it by hand/i);
    assert.equal(
      (
        await getRepository(BackfillSeries).findOneOrFail({
          where: { id: row.id },
        })
      ).status,
      'found'
    );
    const told = notices.find((n) => n.kind === 'failed');
    assert.match(told?.detail ?? '', /never started.*approve it by hand/);
  });

  it('never takes a pack on its own within a day of it failing to start', async () => {
    // Not the limit: something the job cannot get past, ten times.
    fetchFails = () => answered(500);
    const { row, candidate } = await seed();
    const job = await backfill.approve(candidate.id, { mode: 'missing' });
    await ticks(15);
    assert.equal((await jobOf(job.id)).status, 'failed');
    const repo = getRepository(BackfillCandidate);
    const held = await repo.findOneOrFail({ where: { id: candidate.id } });
    assert.equal(held.status, 'ready');
    // The series page says why it waits, beside the pack.
    assert.match(held.reason ?? '', /did not start.*approve it by hand/i);

    // A search finds the same release again, and auto-approve would take
    // it: it is offered, not taken, and still says why.
    fetchFails = () => undefined;
    searchFindsItAgain();
    setTime(now + 2 * HOUR);
    await backfill.search(row.id);
    const jobs = getRepository(BackfillJob);
    assert.equal(await jobs.count(), 1);
    const found = await repo.findOneOrFail({ where: { guid: RELEASE.guid } });
    assert.equal(found.status, 'ready');
    assert.match(found.reason ?? '', /did not start.*approve it by hand/i);

    // Another download of the series failing does not take it either.
    const { candidate: other } = await seed(
      {
        guid: 'https://prowlarr/9/a',
        title: 'TruthTesters.S2016E01.720p.WEB',
        indexer: 'NZBgeek',
        indexerId: 9,
      },
      126
    );
    await getRepository(BackfillCandidate).update(other.id, {
      seriesId: row.id,
      plan: [entry(0, 501)],
      summary: summarize([entry(0, 501)]),
    });
    const second = await backfill.approve(other.id, { mode: 'missing' });
    await (
      backfill as unknown as {
        fail: (j: BackfillJob, r: string) => Promise<void>;
      }
    ).fail(await jobOf(second.id), 'Nothing downloaded for 12 hours');
    while (backfill.isSearching(row.id)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await jobs.count(), 2);

    // A day on, it may be taken again.
    setTime(now + 23 * HOUR);
    await backfill.search(row.id);
    assert.equal(await jobs.count(), 3);
  });

  it('lets an admin approve a held pack by hand, which clears why it was held', async () => {
    fetchFails = () => answered(500);
    const { candidate } = await seed();
    await backfill.approve(candidate.id, { mode: 'missing' });
    await ticks(15);
    fetchFails = () => undefined;
    const job = await backfill.approve(candidate.id, {
      mode: 'missing',
      user: gm,
    });
    assert.equal((await jobOf(job.id)).status, 'downloading');
    const taken = await getRepository(BackfillCandidate).findOneOrFail({
      where: { id: candidate.id },
    });
    assert.equal(taken.status, 'approved');
    assert.equal(taken.reason, null);
  });

  it('cannot loop as it did for TruthTesters', async () => {
    const { row, candidate } = await seed();
    await backfill.approve(candidate.id, { mode: 'missing', user: gm });
    // Twelve hours of minute ticks and hourly scans, with the pack
    // approved again whenever it is offered.
    const reapprovals: string[] = [];
    await ticks(12 * 60, async () => {
      await backfill.scan();
      await backfill.approve(candidate.id, { mode: 'missing', user: gm }).then(
        () => reapprovals.push('approved'),
        (e: Error) => reapprovals.push(e.message)
      );
    });
    const jobs = await getRepository(BackfillJob).find();
    assert.equal(jobs.length, 1, 'one job, still waiting');
    assert.equal(jobs[0].status, 'queued');
    assert.equal(jobs[0].approvedByName, 'Sam');
    assert.ok(
      reapprovals.every((r) => r === 'This pack is not waiting for approval.')
    );
    // 0, 15 min, 45, 1 h 45, 3 h 45, 7 h 45: six requests in twelve hours,
    // not 720.
    assert.equal(fetches, 6);
    const limitLines = jobs[0].log.filter((l) =>
      /download limit/.test(l.message)
    );
    assert.equal(limitLines.length, 1);
    assert.equal(
      (
        await getRepository(BackfillSeries).findOneOrFail({
          where: { id: row.id },
        })
      ).status,
      'downloading'
    );
  });

  it('names who approved a download, and Backfill when it took one itself', async () => {
    fetchFails = () => undefined;
    const { candidate } = await seed();
    const mine = await backfill.approve(candidate.id, {
      mode: 'missing',
      user: gm,
    });
    assert.equal(mine.approvedByName, 'Sam');
    assert.match(mine.log[0].message, /^Sam approved 2 files/);

    const { row, candidate: other } = await seed(
      { guid: 'https://prowlarr/7/b' },
      124
    );
    await getRepository(BackfillCandidate).delete(other.id);
    searchFindsItAgain();
    mock.method(ProwlarrAPI.prototype, 'search', async () => [
      { ...RELEASE, guid: 'https://prowlarr/7/b' },
    ]);
    await backfill.search(row.id);
    const taken = await getRepository(BackfillJob).findOneOrFail({
      where: { seriesId: row.id },
    });
    assert.equal(taken.approvedByName, 'Backfill (auto-approve)');
    assert.match(taken.log[0].message, /^Backfill \(auto-approve\) approved/);
  });
});

describe('what went wrong, in plain words', () => {
  it('says an app did not answer, a limit, or a refused key, by name', () => {
    assert.equal(
      plainProblem(unanswered('http://sabnzbd:8080/api')),
      'SABnzbd did not answer'
    );
    assert.equal(
      plainProblem(
        new Error('[Sonarr] failed', {
          cause: unanswered('http://sonarr:8989/api/v3/rootfolder'),
        })
      ),
      'Sonarr did not answer'
    );
    assert.equal(
      plainProblem(answered(429), 'Tabula Rasa'),
      'Tabula Rasa has reached its download limit'
    );
    assert.equal(
      plainProblem(answered(403), 'Tabula Rasa'),
      'Tabula Rasa refused the API key'
    );
    assert.equal(plainProblem(new Error('Something else')), 'Something else');
  });

  it('writes a refused key on the job by the indexer’s name, and the raw answer only in the server log', async () => {
    fetchFails = () => answered(401);
    const { candidate } = await seed();
    const job = await backfill.approve(candidate.id, { mode: 'missing' });
    await ticks(3);
    const log = (await jobOf(job.id)).log;
    const refused = log.filter(
      (l) => l.message === 'Tabula Rasa refused the API key'
    );
    assert.equal(refused.length, 1, JSON.stringify(log));
    assert.equal(refused[0].count, 4);
    assert.ok(!log.some((l) => /status code/.test(l.message)));
  });
});

describe('searching while Prowlarr is at its limit', () => {
  it('stops asking, and opens no pack from an indexer at its limit', async () => {
    const { row } = await seed();
    searchFindsItAgain();
    let searches = 0;
    mock.method(ProwlarrAPI.prototype, 'search', async () => {
      searches += 1;
      throw answered(429);
    });
    await assert.rejects(
      backfill.search(row.id),
      /Prowlarr has reached its search limit/
    );
    assert.equal(searches, 1, 'no further names searched');
    await assert.rejects(
      backfill.search(row.id),
      /Prowlarr has reached its search limit/
    );
    assert.equal(searches, 1, 'not asked again while it waits');

    // Prowlarr answers, but the indexer the release is on is at its limit.
    setTime(now + 16 * MINUTE);
    mock.method(ProwlarrAPI.prototype, 'search', async () => [RELEASE]);
    indexerLimits.hit({ id: 7, name: 'Tabula Rasa' }, 'download', undefined);
    await backfill.search(row.id);
    assert.equal(fetches, 0);
    const found = await getRepository(BackfillCandidate).findOneOrFail({
      where: { seriesId: row.id, guid: RELEASE.guid },
    });
    assert.equal(found.status, 'failed');
    assert.equal(found.reason, 'Tabula Rasa has reached its download limit');
  });

  it('is told to the admin agent in words, with when to try again', async () => {
    const reached = indexerLimits.hit(
      { name: 'Prowlarr' },
      'search',
      now + 20 * MINUTE
    );
    assert.ok(reached instanceof IndexerLimitReached);
    const { TOOLS } = await import('@server/lib/agent/tools');
    const tool = TOOLS.find((t) => t.name === 'search_indexers')!;
    let asked = 0;
    mock.method(ProwlarrAPI.prototype, 'search', async () => {
      asked += 1;
      return [];
    });
    await assert.rejects(
      tool.run({} as never, { query: 'TruthTesters', kind: 'series' }),
      /Prowlarr has reached its search limit; it can be asked again in about 20 minutes/
    );
    assert.equal(asked, 0);
  });
});

describe('the migration for a job’s wait', () => {
  it('adds the column the entity expects, and takes it away again', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    const hasColumn = async () =>
      !!(await runner.getTable('backfill_job'))?.findColumnByName(
        'indexerWait'
      );
    try {
      await migration.down(runner);
      assert.equal(await hasColumn(), false);
      await migration.up(runner);
      assert.equal(await hasColumn(), true);
    } finally {
      await runner.release();
    }
    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /indexerWait/.test(query)),
      []
    );
  });
});
