import { getRepository } from '@server/datasource';
import AgentRun from '@server/entity/AgentRun';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import MusicMetadata from '@server/entity/MusicMetadata';
import { Session } from '@server/entity/Session';
import { runDbMaintenance } from '@server/lib/dbMaintenance';
import { BACKFILL_DEFAULTS, getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

setupTestDb();

/*
 * The nightly database maintenance: rows nothing reads any more go, what
 * people made or decided stays, and the database is vacuumed after.
 */

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  getSettings().backfill = { ...BACKFILL_DEFAULTS };
});

const session = (id: string, expiredAt: number, destroyed = false) =>
  Object.assign(new Session(), {
    id,
    expiredAt,
    json: '{}',
    ...(destroyed ? { destroyedAt: new Date() } : {}),
  });

const backdate = async (
  table: 'backfill_job' | 'backfill_candidate',
  id: number,
  at: Date
) => {
  const repo =
    table === 'backfill_job'
      ? getRepository(BackfillJob)
      : getRepository(BackfillCandidate);
  await repo
    .createQueryBuilder()
    .update()
    .set(
      table === 'backfill_job'
        ? { finishedAt: at, updatedAt: at }
        : { updatedAt: at }
    )
    .where('id = :id', { id })
    .execute();
};

describe('database maintenance', () => {
  it('clears out what nothing reads, keeps what people made, and vacuums', async () => {
    const now = Date.now();
    await getRepository(Session).save([
      session('live', now + DAY),
      session('expired', now - 1000),
      session('signed-out', now + DAY, true),
    ]);

    const series = await getRepository(BackfillSeries).save(
      new BackfillSeries({
        kind: 'series',
        serverId: 0,
        arrId: 1,
        title: 'Old Show',
        status: 'none',
      })
    );
    const pack = (guid: string, status: BackfillCandidate['status']) =>
      new BackfillCandidate({
        seriesId: series.id,
        guid,
        title: guid,
        indexer: 'x',
        indexerId: 1,
        protocol: 'torrent',
        size: 1,
        status,
        plan: [],
        summary: null,
      });
    const [dead, skipped, ready, keptPack, oldPack] = await getRepository(
      BackfillCandidate
    ).save([
      pack('dead', 'dead'),
      pack('skipped', 'skipped'),
      pack('ready', 'ready'),
      pack('kept', 'approved'),
      pack('old', 'approved'),
    ]);
    const job = (
      candidateId: number,
      status: BackfillJob['status'],
      finishedAt: Date | null
    ) =>
      new BackfillJob({
        seriesId: series.id,
        candidateId,
        title: 'x',
        status,
        mode: 'missing',
        protocol: 'torrent',
        clientId: 1,
        files: [],
        size: 1,
        sizeLeft: 0,
        commandIds: [],
        log: [],
        finishedAt,
      });
    const [oldJob, recentJob, runningJob] = await getRepository(
      BackfillJob
    ).save([
      job(oldPack.id, 'done', null),
      job(keptPack.id, 'failed', new Date(now - DAY)),
      job(keptPack.id, 'downloading', null),
    ]);
    const long = new Date(now - 200 * DAY);
    await backdate('backfill_job', oldJob.id, long);
    for (const c of [dead, skipped, ready, keptPack, oldPack]) {
      await backdate('backfill_candidate', c.id, long);
    }
    await getRepository(AgentRun).save(
      new AgentRun({
        trigger: 'ask',
        status: 'done',
        ask: 'old',
        steps: [],
        actions: [],
        finishedAt: long,
      })
    );

    const kept = (key: string, expiresAt: Date | null) =>
      new MusicMetadata({ key, data: '{}', expiresAt });
    await getRepository(MusicMetadata).save([
      kept('artist:fresh', new Date(now + DAY)),
      // Just past its time: still shown while it is fetched again.
      kept('artist:stale', new Date(now - DAY)),
      kept('artist:forgotten', new Date(now - 40 * DAY)),
      kept('release-rg:forever', null),
    ]);

    const report = await runDbMaintenance(now);
    assert.ok(report);
    assert.deepEqual(report.removed, {
      sessions: 2,
      backfillJobs: 1,
      backfillPacks: 2,
      agentConversations: 1,
      musicMetadata: 1,
    });
    assert.deepEqual(
      (await getRepository(MusicMetadata).find({ order: { key: 'ASC' } })).map(
        (m) => m.key
      ),
      ['artist:fresh', 'artist:stale', 'release-rg:forever']
    );
    assert.match(report.vacuum, /VACUUM|checkpoint/);

    assert.deepEqual(
      (await getRepository(Session).find({ withDeleted: true })).map(
        (s) => s.id
      ),
      ['live']
    );
    assert.deepEqual(
      (await getRepository(BackfillJob).find({ order: { id: 'ASC' } })).map(
        (j) => j.id
      ),
      [recentJob.id, runningJob.id]
    );
    // Turned down by an admin, waiting on one, or what a kept download
    // came from: all stay.
    assert.deepEqual(
      (
        await getRepository(BackfillCandidate).find({ order: { id: 'ASC' } })
      ).map((c) => c.guid),
      ['skipped', 'ready', 'kept']
    );
  });

  it('keeps Backfill history for good when told to', async () => {
    getSettings().backfill = { ...BACKFILL_DEFAULTS, historyDays: 0 };
    const series = await getRepository(BackfillSeries).save(
      new BackfillSeries({
        kind: 'movie',
        serverId: 0,
        arrId: 2,
        title: 'Old Movie',
        status: 'done',
      })
    );
    const done = await getRepository(BackfillJob).save(
      new BackfillJob({
        seriesId: series.id,
        candidateId: null,
        title: 'x',
        status: 'done',
        mode: 'missing',
        protocol: 'torrent',
        clientId: 1,
        files: [],
        size: 1,
        sizeLeft: 0,
        commandIds: [],
        log: [],
      })
    );
    await backdate('backfill_job', done.id, new Date(Date.now() - 900 * DAY));
    const report = await runDbMaintenance();
    assert.equal(report?.removed.backfillJobs, 0);
    assert.equal(await getRepository(BackfillJob).count(), 1);
  });
});
