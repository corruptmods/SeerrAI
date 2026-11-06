import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import AgentRun from '@server/entity/AgentRun';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import type { CheckStatus } from '@server/entity/DownloadCheck';
import DownloadCheck from '@server/entity/DownloadCheck';
import Media from '@server/entity/Media';
import MediaLibraryItem from '@server/entity/MediaLibraryItem';
import MusicMetadata from '@server/entity/MusicMetadata';
import QualityApply from '@server/entity/QualityApply';
import { Session } from '@server/entity/Session';
import { runDbMaintenance } from '@server/lib/dbMaintenance';
import { BACKFILL_DEFAULTS, getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

setupTestDb();

/*
 * Nightly database maintenance: unread rows go, what people made or decided
 * stays, then a vacuum.
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
      // Just expired: still shown while refetched.
      kept('artist:stale', new Date(now - DAY)),
      kept('artist:forgotten', new Date(now - 40 * DAY)),
      kept('release-rg:forever', null),
    ]);

    // Old Download Check findings go unless awaiting an admin.
    const finding = (key: string, status: CheckStatus, at: number) =>
      new DownloadCheck({
        app: 'sonarr',
        serverId: 0,
        downloadKey: key,
        stage: 'grab',
        title: key,
        itemId: 1,
        itemTitle: 'Show',
        finding: 'early',
        action: status === 'waiting' ? 'review' : 'reject',
        status,
        createdAt: new Date(at),
        updatedAt: new Date(at),
      });
    await getRepository(DownloadCheck).save([
      finding('old-done', 'done', now - 100 * DAY),
      finding('old-waiting', 'waiting', now - 100 * DAY),
      finding('new-done', 'done', now - DAY),
    ]);

    const report = await runDbMaintenance(now);
    assert.ok(report);
    assert.deepEqual(report.removed, {
      sessions: 2,
      backfillJobs: 1,
      backfillPacks: 2,
      agentConversations: 1,
      musicMetadata: 1,
      downloadChecks: 1,
      libraryItems: 0,
      qualityApplies: 0,
    });
    assert.deepEqual(
      (
        await getRepository(DownloadCheck).find({
          order: { downloadKey: 'ASC' },
        })
      ).map((r) => r.downloadKey),
      ['new-done', 'old-waiting']
    );
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
    // Rejected, awaiting an admin, or a kept download's source: all stay.
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

  it('forgets which library held a title on a server or library that is gone', async () => {
    const settings = getSettings();
    const saved = {
      type: settings.main.mediaServerType,
      plex: settings.plex.libraries,
      jellyfin: { ...settings.jellyfin },
      emby: { ...settings.emby },
    };
    try {
      settings.main.mediaServerType = MediaServerType.PLEX;
      const library = (id: string, enabled: boolean) => ({
        id,
        name: id,
        enabled,
        type: 'movie' as const,
      });
      // Library 1 is scanned, 2 is turned off here, 3 was removed from Plex.
      settings.plex.libraries = [library('1', true), library('2', false)];
      // Jellyfin is connected but its libraries were never synced; Emby isn't.
      settings.jellyfin = {
        ...settings.jellyfin,
        connected: true,
        libraries: [],
      };
      settings.emby = { ...settings.emby, connected: false };

      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 4401,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.AVAILABLE,
          ratingKey: 'glasswing',
        })
      );
      const item = (server: 'plex' | 'jellyfin' | 'emby', libraryId: string) =>
        new MediaLibraryItem({
          mediaId: media.id,
          server,
          libraryId,
          is4k: false,
          itemId: `${server}-${libraryId}`,
        });
      await getRepository(MediaLibraryItem).save([
        item('plex', '1'),
        item('plex', '2'),
        item('plex', '3'),
        item('jellyfin', 'abc'),
        item('emby', 'def'),
      ]);

      const report = await runDbMaintenance();
      assert.equal(report?.removed.libraryItems, 2);
      assert.deepEqual(
        (
          await getRepository(MediaLibraryItem).find({
            order: { server: 'ASC', libraryId: 'ASC' },
          })
        ).map((row) => `${row.server}:${row.libraryId}`),
        ['jellyfin:abc', 'plex:1', 'plex:2']
      );
    } finally {
      settings.main.mediaServerType = saved.type;
      settings.plex.libraries = saved.plex;
      settings.jellyfin = saved.jellyfin;
      settings.emby = saved.emby;
    }
  });

  it('keeps the quality applies History lists, and what each server still needs', async () => {
    const apply = (serverId: number, undone = false) =>
      new QualityApply({
        serverKind: 'radarr',
        serverId,
        userId: null,
        summary: { created: 1, updated: 0 },
        befores: [],
        moved: [],
        undoneAt: undone ? new Date() : null,
      });
    const repo = getRepository(QualityApply);
    // Long ago, server 2 applied (what Undo reverts now) and then applied
    // again and undid that. Since then server 1 has applied 51 times.
    const [undoableOf2] = await repo.save([apply(2)]);
    const [newestOf2] = await repo.save([apply(2, true)]);
    const [oldestOf1] = await repo.save([apply(1)]);
    await repo.save(
      Array.from({ length: QualityApply.HISTORY_SHOWN }, () => apply(1))
    );

    const report = await runDbMaintenance();
    // Server 1's oldest goes: History lists the 50 after it. Server 2 keeps
    // both, though History no longer lists them.
    assert.equal(report?.removed.qualityApplies, 1);
    const left = new Set(
      (await repo.find({ select: { id: true } })).map((r) => r.id)
    );
    assert.equal(left.size, QualityApply.HISTORY_SHOWN + 2);
    assert.ok(!left.has(oldestOf1.id));
    assert.ok(left.has(undoableOf2.id) && left.has(newestOf2.id));
  });
});
