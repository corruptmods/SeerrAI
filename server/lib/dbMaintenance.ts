import dataSource, { getRepository } from '@server/datasource';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillJob from '@server/entity/BackfillJob';
import DownloadCheck from '@server/entity/DownloadCheck';
import MediaLibraryItem from '@server/entity/MediaLibraryItem';
import MusicMetadata from '@server/entity/MusicMetadata';
import QualityApply from '@server/entity/QualityApply';
import { Session } from '@server/entity/Session';
import agent from '@server/lib/agent';
import { connectedServers, MEDIA_SERVER_KINDS } from '@server/lib/mediaServers';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isPgsql } from '@server/utils/dbType';
import { In, IsNull, LessThan, Not } from 'typeorm';

/*
 * Nightly pruning of rows nothing reads: ended sessions, Backfill's finished
 * downloads and spent packs past the days kept, old admin agent
 * conversations, long-expired music details, which library held a title on
 * a server or library that is gone, quality applies History no longer lists.
 * Then vacuums (Postgres) or checkpoints and
 * compacts when worth it (SQLite).
 *
 * Never touches user data: requests, issues, history, watchlists, and packs
 * an admin rejected (Backfill must not offer those again).
 */

const LABEL = 'Database';
const DAY = 24 * 60 * 60 * 1000;

/** Terminal Backfill download statuses. */
const FINISHED_JOBS: BackfillJob['status'][] = ['done', 'failed', 'cancelled'];
/**
 * Packs that are only a record. Not ready (they await an admin) or skipped
 * (they stop a refused release being offered again).
 */
const SPENT_CANDIDATES: BackfillCandidate['status'][] = [
  'approved',
  'dead',
  'rejected',
  'failed',
];

/** Compact SQLite once free pages reach this share of the file. */
const SQLITE_FREE_SHARE = 0.1;

export interface MaintenanceReport {
  at: string;
  removed: {
    sessions: number;
    backfillJobs: number;
    backfillPacks: number;
    agentConversations: number;
    musicMetadata: number;
    downloadChecks: number;
    libraryItems: number;
    qualityApplies: number;
  };
  /** VACUUM (ANALYZE) on Postgres; checkpoint, optimize and maybe VACUUM on SQLite. */
  vacuum: string;
  tookMs: number;
}

let running = false;
let last: MaintenanceReport | null = null;

export const maintenanceStatus = () => ({ running, last });

/** Expired or signed-out sessions; the store only clears a few at a time. */
const pruneSessions = async (now: number): Promise<number> => {
  const sessions = getRepository(Session);
  const expired = await sessions.delete({ expiredAt: LessThan(now) });
  const ended = await sessions.delete({ destroyedAt: Not(IsNull()) });
  return (expired.affected ?? 0) + (ended.affected ?? 0);
};

/**
 * Backfill's finished downloads past the days kept, and their spent packs.
 * A pack a kept download came from is kept.
 */
const pruneBackfill = async (
  now: number
): Promise<{ jobs: number; packs: number }> => {
  const days = getSettings().backfill.historyDays;
  if (!days) return { jobs: 0, packs: 0 };
  const before = new Date(now - days * DAY);
  const jobs = await getRepository(BackfillJob).delete({
    status: In(FINISHED_JOBS),
    finishedAt: LessThan(before),
  });
  const kept = await getRepository(BackfillJob).find({
    select: { candidateId: true },
    where: { candidateId: Not(IsNull()) },
  });
  const inUse = [...new Set(kept.map((j) => j.candidateId!))];
  const packs = await getRepository(BackfillCandidate).delete({
    status: In(SPENT_CANDIDATES),
    updatedAt: LessThan(before),
    ...(inUse.length ? { id: Not(In(inUse)) } : {}),
  });
  return { jobs: jobs.affected ?? 0, packs: packs.affected ?? 0 };
};

/**
 * Download Check findings past Backfill's days kept, except those awaiting an
 * admin.
 */
const pruneDownloadChecks = async (now: number): Promise<number> => {
  const days = getSettings().backfill.historyDays;
  if (!days) return 0;
  const result = await getRepository(DownloadCheck).delete({
    createdAt: LessThan(new Date(now - days * DAY)),
    status: Not('waiting'),
  });
  return result.affected ?? 0;
};

/**
 * Delete MusicBrainz data a month past expiry. Recently expired data is
 * still shown while refreshing; data this old is for something nobody views.
 */
const MUSIC_METADATA_GRACE = 30 * DAY;

const pruneMusicMetadata = async (now: number): Promise<number> => {
  const result = await getRepository(MusicMetadata).delete({
    expiresAt: LessThan(new Date(now - MUSIC_METADATA_GRACE)),
  });
  return result.affected ?? 0;
};

/**
 * Which library holds a title, for a media server no longer connected or a
 * library its server no longer lists. Scans clear only the libraries they
 * read, so nothing else removes these, and a stale row could hide a title
 * from someone who can now open it. A disabled library's rows are kept: they
 * still hide its titles from people who can't open it.
 */
const pruneLibraryItems = async (): Promise<number> => {
  const settings = getSettings();
  const connected = connectedServers();
  const repo = getRepository(MediaLibraryItem);
  let removed = 0;
  for (const kind of MEDIA_SERVER_KINDS) {
    if (!connected.includes(kind)) {
      removed += (await repo.delete({ server: kind })).affected ?? 0;
      continue;
    }
    const listed = settings[kind].libraries ?? [];
    // Not synced from the server yet: nothing to compare with.
    if (!listed.length) continue;
    const result = await repo.delete({
      server: kind,
      libraryId: Not(
        In(listed.map((library) => MediaLibraryItem.key(kind, library.id)))
      ),
    });
    removed += result.affected ?? 0;
  }
  return removed;
};

/** Rows removed per delete. */
const DELETE_CHUNK = 500;

/**
 * Quality applies older than those History lists, with the copies kept for
 * Undo. Each server's newest apply stays (its last-applied date), and its
 * newest not undone (what Undo reverts).
 */
const pruneQualityApplies = async (): Promise<number> => {
  const repo = getRepository(QualityApply);
  const rows = await repo.find({
    select: { id: true, serverKind: true, serverId: true, undoneAt: true },
    order: { id: 'DESC' },
  });
  if (rows.length <= QualityApply.HISTORY_SHOWN) return 0;
  const newest = new Set<string>();
  const undoable = new Set<string>();
  const gone: number[] = [];
  rows.forEach((row, index) => {
    const server = `${row.serverKind}:${row.serverId}`;
    let keep = index < QualityApply.HISTORY_SHOWN;
    if (!newest.has(server)) {
      newest.add(server);
      keep = true;
    }
    if (!row.undoneAt && !undoable.has(server)) {
      undoable.add(server);
      keep = true;
    }
    if (!keep) gone.push(row.id);
  });
  for (let i = 0; i < gone.length; i += DELETE_CHUNK) {
    await repo.delete({ id: In(gone.slice(i, i + DELETE_CHUNK)) });
  }
  return gone.length;
};

const vacuum = async (): Promise<string> => {
  if (isPgsql) {
    // Must run outside a transaction. Autovacuum lags the night's deletes
    // and doesn't refresh statistics.
    await dataSource.query('VACUUM (ANALYZE)');
    return 'VACUUM (ANALYZE)';
  }
  await dataSource.query('PRAGMA wal_checkpoint(TRUNCATE)');
  const [{ page_count: pages }] = (await dataSource.query(
    'PRAGMA page_count'
  )) as { page_count: number }[];
  const [{ freelist_count: free }] = (await dataSource.query(
    'PRAGMA freelist_count'
  )) as { freelist_count: number }[];
  const done = ['checkpoint'];
  // A full rewrite is only worth it once much of the file is empty.
  if (pages > 0 && free / pages >= SQLITE_FREE_SHARE) {
    await dataSource.query('VACUUM');
    await dataSource.query('PRAGMA wal_checkpoint(TRUNCATE)');
    done.push(`VACUUM (${free} of ${pages} pages free)`);
  }
  await dataSource.query('PRAGMA optimize');
  done.push('optimize');
  return done.join(', ');
};

/** One pass; returns null at once if one is already running. */
export const runDbMaintenance = async (
  now = Date.now()
): Promise<MaintenanceReport | null> => {
  if (running) return null;
  running = true;
  const started = Date.now();
  try {
    const sessions = await pruneSessions(now);
    const backfill = await pruneBackfill(now);
    const agentConversations = await agent.purge(now);
    const musicMetadata = await pruneMusicMetadata(now);
    const downloadChecks = await pruneDownloadChecks(now);
    const libraryItems = await pruneLibraryItems();
    const qualityApplies = await pruneQualityApplies();
    let vacuumed: string;
    try {
      vacuumed = await vacuum();
    } catch (e) {
      // Pruning still counts; the next night retries.
      const message = e instanceof Error ? e.message : String(e);
      vacuumed = `failed: ${message}`;
      logger.warn('Database vacuum failed', {
        label: LABEL,
        errorMessage: message,
      });
    }
    last = {
      at: new Date(now).toISOString(),
      removed: {
        sessions,
        backfillJobs: backfill.jobs,
        backfillPacks: backfill.packs,
        agentConversations,
        musicMetadata,
        downloadChecks,
        libraryItems,
        qualityApplies,
      },
      vacuum: vacuumed,
      tookMs: Date.now() - started,
    };
    logger.info('Database maintenance done', { label: LABEL, ...last });
    return last;
  } catch (e) {
    logger.error('Database maintenance failed', {
      label: LABEL,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    throw e;
  } finally {
    running = false;
  }
};
