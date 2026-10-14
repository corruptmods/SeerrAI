import dataSource, { getRepository } from '@server/datasource';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillJob from '@server/entity/BackfillJob';
import MusicMetadata from '@server/entity/MusicMetadata';
import { Session } from '@server/entity/Session';
import agent from '@server/lib/agent';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isPgsql } from '@server/utils/dbType';
import { In, IsNull, LessThan, Not } from 'typeorm';

/*
 * Keeps the database from filling with rows nothing reads any more, and
 * gives the space back. Every night: sessions that ended, Backfill's
 * finished downloads and the packs it looked at past the days kept, old
 * admin agent conversations, music details long past their time; then the database is vacuumed (Postgres) or
 * checkpointed and compacted when worth it (SQLite).
 *
 * What people made is never touched: requests, issues, history, watchlists,
 * and packs an admin turned down (Backfill must not offer those again).
 */

const LABEL = 'Database';
const DAY = 24 * 60 * 60 * 1000;

/** Statuses a Backfill download no longer changes from. */
const FINISHED_JOBS: BackfillJob['status'][] = ['done', 'failed', 'cancelled'];
/**
 * Packs that are only a record of what happened. Ready ones wait for an
 * admin; skipped ones keep a refused release from being offered again.
 */
const SPENT_CANDIDATES: BackfillCandidate['status'][] = [
  'approved',
  'dead',
  'rejected',
  'failed',
];

/** SQLite is compacted once free pages are this share of the file. */
const SQLITE_FREE_SHARE = 0.1;

export interface MaintenanceReport {
  at: string;
  removed: {
    sessions: number;
    backfillJobs: number;
    backfillPacks: number;
    agentConversations: number;
    musicMetadata: number;
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
 * Backfill's finished downloads past the days kept, and the packs they and
 * old searches left behind. A pack a kept download came from stays with it.
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
 * Kept MusicBrainz answers a month past their time. One just past it is
 * still shown while a fresh copy is fetched; one this old is for an artist
 * or album nobody has looked at since.
 */
const MUSIC_METADATA_GRACE = 30 * DAY;

const pruneMusicMetadata = async (now: number): Promise<number> => {
  const result = await getRepository(MusicMetadata).delete({
    expiresAt: LessThan(new Date(now - MUSIC_METADATA_GRACE)),
  });
  return result.affected ?? 0;
};

const vacuum = async (): Promise<string> => {
  if (isPgsql) {
    // Outside a transaction, as VACUUM must be. Autovacuum does this too,
    // but not right after a night's deletes, and not the statistics.
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
  // Rewriting the whole file is only worth it once much of it is empty.
  if (pages > 0 && free / pages >= SQLITE_FREE_SHARE) {
    await dataSource.query('VACUUM');
    await dataSource.query('PRAGMA wal_checkpoint(TRUNCATE)');
    done.push(`VACUUM (${free} of ${pages} pages free)`);
  }
  await dataSource.query('PRAGMA optimize');
  done.push('optimize');
  return done.join(', ');
};

/** One pass. A call while one is running returns null at once. */
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
    let vacuumed: string;
    try {
      vacuumed = await vacuum();
    } catch (e) {
      // Pruning still counts; the next night tries again.
      vacuumed = `failed: ${e instanceof Error ? e.message : String(e)}`;
      logger.warn('Database vacuum failed', {
        label: LABEL,
        errorMessage: e instanceof Error ? e.message : String(e),
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
