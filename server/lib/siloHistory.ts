import type SiloAPI from '@server/api/silo/client';
import type { SiloPlaybackHistoryEntry } from '@server/api/silo/types';
import { getRepository } from '@server/datasource';
import SiloEpisode from '@server/entity/SiloEpisode';
import SiloPlay from '@server/entity/SiloPlay';
import { isConnected } from '@server/lib/mediaServers';
import { getSettings } from '@server/lib/settings';
import { siloClient } from '@server/lib/silo';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * Seerr AI's copy of Silo's play history (silo_play), so watch history reads
 * don't walk Silo's history each time.
 *
 * Every few minutes (the silo-history-sync job, and before a watch history
 * read) Seerr AI reads the plays that ended since the last read that
 * finished (its mark, settings.silo.historyCopiedTo), less an overlap, and
 * stores them by Silo's session id: Silo may update a play later, moving its
 * end on, and the overlap covers plays Silo was recording while the last
 * read ran. The mark moves to the newest play Silo listed, of any kind, only
 * once a read has gone through every page, so a read that fails part-way
 * is read again from the old mark. The first read copies everything.
 *
 * Silo's history names neither the episode's series nor anything once the
 * item has left its catalog, so each new play's title is found when it is
 * copied (from the scans' episode list, else Silo's catalog) and kept on the
 * row: a play keeps its title after the episode or film is gone.
 *
 * Nightly, Database Maintenance reads Silo's whole history again: plays are
 * refreshed (Silo can move a play to another item) and those Silo no longer
 * has are dropped. Nothing else is ever removed: plays are kept however old,
 * as Tautulli keeps Plex's.
 */

const LABEL = 'Silo History';

/** Re-read before the newest stored play, for plays recorded mid-read. */
export const SILO_HISTORY_OVERLAP_MS = 15 * 60 * 1000;

/** A read this recent is fresh enough for watch history. */
const FRESH_MS = 30 * 1000;

/** Rows written per statement. */
const WRITE_CHUNK = 50;

/** Rows removed per statement. */
const DELETE_CHUNK = 500;

/** Item types Seerr AI keeps plays of; Silo also plays books and podcasts. */
const VIDEO = new Set(['movie', 'episode']);

export interface SiloHistoryResult {
  /** A full re-read, rather than plays since the newest stored. */
  full: boolean;
  /** Plays Silo listed. */
  read: number;
  /** Plays added or refreshed. */
  stored: number;
  /** Plays dropped because Silo no longer has them (full re-reads only). */
  removed: number;
}

/** What a play belongs to, as found when it is copied. */
interface Placement {
  kind: string;
  titleId: string | null;
  title: string;
  season: number | null;
  episode: number | null;
}

const blank = (value?: string | null) => !value?.trim();

const percentOf = (entry: SiloPlaybackHistoryEntry): number => {
  const duration = entry.duration_seconds ?? 0;
  if (!(duration > 0)) return entry.completed ? 100 : 0;
  const share = ((entry.end_position_seconds ?? 0) / duration) * 100;
  return Math.round(Math.min(100, Math.max(0, share)));
};

/**
 * Who played it, as Silo names them: the profile, unless Silo had only its
 * id, then the account.
 */
const viewerNameOf = (entry: SiloPlaybackHistoryEntry): string => {
  const profile = entry.profile_name?.trim() ?? '';
  const named = profile && profile !== entry.profile_id ? profile : '';
  return named || entry.username?.trim() || profile;
};

/** Whether Silo's row could be a film or episode play. */
const isVideo = (entry: SiloPlaybackHistoryEntry): boolean =>
  !blank(entry.media_item_id) &&
  (blank(entry.media_type) || VIDEO.has(entry.media_type ?? ''));

/**
 * Where each play belongs, for those whose item is new to Seerr AI's copy:
 * a film is its own title; an episode's series comes from the scans'
 * episode list, else Silo's catalog. An item Silo no longer has keeps what
 * its history row and the episode list still say.
 */
const placementsFor = async (
  client: SiloAPI,
  entries: SiloPlaybackHistoryEntry[]
): Promise<Map<string, Placement>> => {
  const placed = new Map<string, Placement>();
  const unknown = new Set<string>();
  for (const entry of entries) {
    if (entry.media_type === 'movie') {
      placed.set(entry.media_item_id, {
        kind: 'movie',
        titleId: entry.media_item_id,
        title: entry.media_title ?? '',
        season: null,
        episode: null,
      });
    } else {
      unknown.add(entry.media_item_id);
    }
  }
  if (!unknown.size) return placed;

  const stored = await getRepository(SiloEpisode).find({
    select: { contentId: true, seriesId: true, season: true, episode: true },
    where: { contentId: In([...unknown]) },
  });
  const episodes = new Map(stored.map((row) => [row.contentId, row]));
  const ask = [...unknown].filter((id) => !episodes.has(id));
  const catalog = new Map(
    (ask.length ? await client.getCatalogItems(ask) : []).map((item) => [
      item.content_id,
      item,
    ])
  );

  for (const entry of entries) {
    const id = entry.media_item_id;
    if (placed.has(id) || !unknown.has(id)) continue;
    const episode = episodes.get(id);
    const item = catalog.get(id);
    if (item?.type === 'movie') {
      placed.set(id, {
        kind: 'movie',
        titleId: id,
        title: item.title ?? entry.media_title ?? '',
        season: null,
        episode: null,
      });
    } else if (item?.type === 'episode' || episode) {
      placed.set(id, {
        kind: 'episode',
        titleId: item?.series_id || episode?.seriesId || null,
        title: entry.series_title || item?.series_title || '',
        season:
          entry.season_number ?? item?.season_number ?? episode?.season ?? null,
        episode:
          entry.episode_number ??
          item?.episode_number ??
          episode?.episode ??
          null,
      });
    } else if (entry.media_type === 'episode') {
      // An episode Silo still lists in its history but not its catalog.
      placed.set(id, {
        kind: 'episode',
        titleId: null,
        title: entry.series_title ?? '',
        season: entry.season_number ?? null,
        episode: entry.episode_number ?? null,
      });
    }
  }
  return placed;
};

/**
 * Stores one page of Silo's history; returns how many plays were added or
 * refreshed. `retry` looks again for the title of plays stored without one.
 */
const storePage = async (
  client: SiloAPI,
  page: SiloPlaybackHistoryEntry[],
  retry: boolean
): Promise<number> => {
  const entries = page.filter(isVideo);
  if (!entries.length) return 0;
  const repo = getRepository(SiloPlay);
  const existing = new Map(
    (
      await repo.find({
        where: { sessionId: In(entries.map((entry) => entry.session_id)) },
      })
    ).map((row) => [row.sessionId, row])
  );
  const fresh = entries.filter((entry) => {
    const row = existing.get(entry.session_id);
    return (
      !row || row.itemId !== entry.media_item_id || (retry && !row.titleId)
    );
  });
  const placements = fresh.length
    ? await placementsFor(client, fresh)
    : new Map<string, Placement>();

  const rows = entries.map((entry) => {
    const row = existing.get(entry.session_id);
    const kept =
      row && row.itemId === entry.media_item_id
        ? {
            kind: row.kind,
            titleId: row.titleId ?? null,
            title: row.title,
            season: row.season ?? null,
            episode: row.episode ?? null,
          }
        : undefined;
    const found = placements.get(entry.media_item_id);
    const place: Placement = {
      kind: found?.kind || kept?.kind || '',
      titleId: found?.titleId ?? kept?.titleId ?? null,
      title: found?.title || kept?.title || '',
      season: found?.season ?? kept?.season ?? null,
      episode: found?.episode ?? kept?.episode ?? null,
    };
    return {
      sessionId: entry.session_id,
      userId: String(entry.user_id),
      profileId: blank(entry.profile_id) ? null : String(entry.profile_id),
      itemId: entry.media_item_id,
      ...place,
      endedAt: new Date(entry.ended_at),
      completed: !!entry.completed,
      percent: percentOf(entry),
      viewerName: viewerNameOf(entry) || row?.viewerName || '',
    };
  });
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    await repo.upsert(rows.slice(i, i + WRITE_CHUNK), ['sessionId']);
  }
  return rows.length;
};

/** Until when the copy is complete; undefined before a first full read. */
const copiedTo = (): Date | undefined => {
  const mark = getSettings().silo.historyCopiedTo;
  const time = mark ? Date.parse(mark) : NaN;
  return Number.isFinite(time) ? new Date(time) : undefined;
};

/** Moves the mark on, after a read that went through every page. */
const markCopiedTo = async (newest: Date | undefined): Promise<void> => {
  const mark = copiedTo();
  if (!newest || (mark && mark.getTime() >= newest.getTime())) return;
  const settings = getSettings();
  settings.silo.historyCopiedTo = newest.toISOString();
  await settings.save();
};

/**
 * Bumped when Silo is removed or replaced: a read started before stops
 * before writing anything more, so the old Silo's plays never come back.
 */
let generation = 0;

/** A read stopped because Silo was removed or replaced meanwhile. */
export class SiloHistoryStopped extends Error {
  constructor() {
    super('Silo was removed or replaced while its history was being read.');
    this.name = 'SiloHistoryStopped';
  }
}

/** Throws once the Silo a read started on is no longer the connected one. */
type StillCurrent = () => void;

const stillCurrentFrom = (): StillCurrent => {
  const started = generation;
  const serverId = getSettings().silo.serverId;
  return () => {
    if (
      generation !== started ||
      getSettings().silo.serverId !== serverId ||
      !isConnected('silo')
    ) {
      throw new SiloHistoryStopped();
    }
  };
};

/** Reads plays that ended from `after` on (everything without it). */
const readFrom = async (
  client: SiloAPI,
  after: Date | undefined,
  retry: boolean,
  still: StillCurrent,
  seen?: Set<string>
): Promise<{ read: number; stored: number; newest?: Date }> => {
  let read = 0;
  let stored = 0;
  let newest: Date | undefined;
  for await (const page of client.playbackHistoryPages({ endedAfter: after })) {
    if (!newest && page.length) newest = new Date(page[0].ended_at);
    read += page.length;
    page.forEach((entry) => seen?.add(entry.session_id));
    still();
    stored += await storePage(client, page, retry);
  }
  return { read, stored, newest };
};

/** Drops stored plays Silo didn't list; returns how many. */
const dropUnlisted = async (seen: Set<string>): Promise<number> => {
  const repo = getRepository(SiloPlay);
  const stored = await repo.find({ select: { id: true, sessionId: true } });
  if (!seen.size && stored.length > 1) {
    // Silo answering with no plays at all is far more likely a wrong answer
    // than every play deleted at once.
    logger.warn(
      "Silo listed no plays at all; keeping Seerr AI's copy as it is",
      {
        label: LABEL,
        plays: stored.length,
      }
    );
    return 0;
  }
  const gone = stored.filter((row) => !seen.has(row.sessionId));
  for (let i = 0; i < gone.length; i += DELETE_CHUNK) {
    await repo.delete({
      id: In(gone.slice(i, i + DELETE_CHUNK).map((row) => row.id)),
    });
  }
  return gone.length;
};

const run = async (full: boolean): Promise<SiloHistoryResult> => {
  const still = stillCurrentFrom();
  const client = siloClient();
  await client.getCompatibleInfo();
  if (!full) {
    const mark = copiedTo();
    const after = mark
      ? new Date(mark.getTime() - SILO_HISTORY_OVERLAP_MS)
      : undefined;
    const { read, stored, newest } = await readFrom(
      client,
      after,
      false,
      still
    );
    still();
    await markCopiedTo(newest);
    return { full, read, stored, removed: 0 };
  }
  // Everything, then again from just before the newest play Silo listed: a
  // play Silo moved on while the long read ran is listed by the second read.
  const seen = new Set<string>();
  const all = await readFrom(client, undefined, true, still, seen);
  const since = all.newest
    ? new Date(all.newest.getTime() - SILO_HISTORY_OVERLAP_MS)
    : undefined;
  const late = since
    ? await readFrom(client, since, true, still, seen)
    : { read: 0, stored: 0 };
  still();
  const removed = await dropUnlisted(seen);
  still();
  await markCopiedTo(all.newest);
  return {
    full,
    read: all.read,
    stored: all.stored + late.stored,
    removed,
  };
};

let current: { full: boolean; promise: Promise<SiloHistoryResult> } | undefined;
let syncedAt = 0;

/**
 * Copies Silo's new plays (a full re-read with `full`). One read at a time:
 * a call while one runs waits for it, or for a full re-read, runs after.
 * Throws when Silo can't be read; the copy stays as it was.
 */
export const syncSiloHistory = async ({
  full = false,
}: { full?: boolean } = {}): Promise<SiloHistoryResult> => {
  while (current) {
    if (!full || current.full) return current.promise;
    await current.promise.catch(() => undefined);
  }
  const promise: Promise<SiloHistoryResult> = run(full)
    .then((result) => {
      syncedAt = Date.now();
      return result;
    })
    .finally(() => {
      // A read stopped by stopSiloHistory may end after a new one began.
      if (current?.promise === promise) current = undefined;
    });
  current = { full, promise };
  return promise;
};

/**
 * Silo was removed or replaced: a read under way stops before writing more,
 * and the next read starts afresh.
 */
export const stopSiloHistory = (): void => {
  generation += 1;
  current = undefined;
  syncedAt = 0;
};

/**
 * Brings the copy up to date before it is read, unless it just was. Throws
 * when Silo can't be read: "could not ask" is not "watched nothing".
 */
export const freshSiloHistory = async (): Promise<void> => {
  if (Date.now() - syncedAt < FRESH_MS && !current) return;
  await syncSiloHistory();
};

/** Forgets when the copy was last brought up to date (tests). */
export const resetSiloHistorySync = (): void => {
  syncedAt = 0;
};

/** The silo-history-sync job: never throws; Silo down is retried next run. */
export const siloHistorySync = {
  running: () => !!current,
  run: async (): Promise<void> => {
    if (!isConnected('silo')) return;
    try {
      const result = await syncSiloHistory();
      logger.debug('Copied new plays from Silo', { label: LABEL, ...result });
    } catch (e) {
      logger.warn(
        "Silo's play history couldn't be read; trying again next run",
        {
          label: LABEL,
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );
    }
  },
};

/**
 * The nightly re-read, for Database Maintenance: plays Silo no longer has
 * are dropped. 0 removed while Silo can't be read; all of them once Silo is
 * disconnected (a reconnect copies them again).
 */
export const pruneSiloPlays = async (): Promise<number> => {
  const repo = getRepository(SiloPlay);
  if (!isConnected('silo')) {
    const count = await repo.count();
    if (count) await repo.clear();
    const settings = getSettings();
    if (settings.silo.historyCopiedTo) {
      settings.silo.historyCopiedTo = '';
      await settings.save();
    }
    return count;
  }
  try {
    return (await syncSiloHistory({ full: true })).removed;
  } catch (e) {
    logger.warn("Silo's play history couldn't be read again in full", {
      label: 'Database',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return 0;
  }
};
