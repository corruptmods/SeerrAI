import type { MaintainerrCollection } from '@server/api/maintainerr';
import MaintainerrAPI, { DELETING_ACTIONS } from '@server/api/maintainerr';
import type { VideoMediaType } from '@server/constants/media';
import { MediaType } from '@server/constants/media';
import { MediaEventType, recordMediaEvent } from '@server/lib/mediaHistory';
import type { MaintainerrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

/*
 * Each Maintainerr server's deletion schedule, in memory.
 *
 * Servers are held separately: an unreachable one keeps its last good answer
 * and records the error for the health page. Refreshed on read once older
 * than REFRESH_AFTER_MS.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 15 * 60 * 1000;
/** Minimum wait before a Keep on an unscheduled title refreshes again. */
const MISS_REFRESH_AFTER_MS = 60 * 1000;

export interface DeletingSoonCollection {
  id: number;
  title: string;
  /** Maintainerr's media server id for the item, which postponing needs. */
  mediaServerId: string;
}

/** One server's plan for one title. */
interface Hold {
  serverId: number;
  /** The earliest deletion across that server's rules. */
  deleteAt: Date;
  collections: DeletingSoonCollection[];
}

interface ServerEntry extends Hold {
  tmdbId: number;
  mediaType: VideoMediaType;
}

interface ServerSnapshot {
  fetchedAt: number;
  entries: Map<string, ServerEntry>;
}

/** A title as shown to users: soonest date and allowed actions. */
export interface DeletingSoonItem {
  tmdbId: number;
  mediaType: VideoMediaType;
  deleteAt: Date;
  showBadge: boolean;
  showInRow: boolean;
  /**
   * Only when every server about to delete it allows Keep; otherwise Keep
   * would postpone one deletion while another goes ahead.
   */
  canKeep: boolean;
}

const snapshots = new Map<number, ServerSnapshot>();
const lastErrors = new Map<number, { at: Date; message: string }>();
/** When each server was last asked, answered or not. */
const attemptedAt = new Map<number, number>();
let refreshedOnce = false;
let inFlight: Promise<void> | null = null;

const keyOf = (mediaType: MediaType, tmdbId: number) =>
  `${mediaType}:${tmdbId}`;

const configuredServers = (): MaintainerrSettings[] =>
  (getSettings().maintainerr ?? []).filter((server) => !!server.hostname);

export const isMaintainerrConfigured = (): boolean =>
  configuredServers().length > 0;

/**
 * Whether a collection deletes its items. Season and episode collections are
 * excluded: they delete part of a show, so marking the whole series is wrong.
 */
export const collectionDeletes = (collection: MaintainerrCollection): boolean =>
  collection.isActive &&
  (collection.deleteAfterDays ?? 0) > 0 &&
  DELETING_ACTIONS.has(collection.arrAction) &&
  (collection.type === 'movie' || collection.type === 'show');

const fetchServer = async (
  server: MaintainerrSettings
): Promise<ServerSnapshot> => {
  const entries = new Map<string, ServerEntry>();
  const api = new MaintainerrAPI(server);
  const collections = (await api.getCollections()).filter(collectionDeletes);

  // Sequential: there are few rules, and Maintainerr doesn't handle bursts.
  for (const collection of collections) {
    const mediaType =
      collection.type === 'movie' ? MediaType.MOVIE : MediaType.TV;

    for (const media of await api.getCollectionMedia(collection.id)) {
      const added = new Date(media.addDate).getTime();

      if (!media.tmdbId || Number.isNaN(added)) {
        continue;
      }

      const deleteAt = new Date(
        added + (collection.deleteAfterDays ?? 0) * DAY_MS
      );
      const key = keyOf(mediaType, media.tmdbId);
      const entry = entries.get(key) ?? {
        serverId: server.id,
        tmdbId: media.tmdbId,
        mediaType,
        deleteAt,
        collections: [],
      };

      entry.collections.push({
        id: collection.id,
        title: collection.title,
        mediaServerId: media.mediaServerId,
      });

      if (deleteAt < entry.deleteAt) {
        entry.deleteAt = deleteAt;
      }

      entries.set(key, entry);
    }
  }

  return { fetchedAt: Date.now(), entries };
};

/** Fetches every server afresh. Concurrent callers share one refresh. */
export const refreshDeletingSoon = async (): Promise<void> => {
  if (!inFlight) {
    inFlight = (async () => {
      const servers = configuredServers();

      // Forget removed servers.
      for (const id of [...snapshots.keys()]) {
        if (!servers.some((server) => server.id === id)) {
          snapshots.delete(id);
          lastErrors.delete(id);
        }
      }
      for (const id of [...attemptedAt.keys()]) {
        if (!servers.some((server) => server.id === id)) {
          attemptedAt.delete(id);
        }
      }

      for (const server of servers) {
        attemptedAt.set(server.id, Date.now());
        try {
          snapshots.set(server.id, await fetchServer(server));
          lastErrors.delete(server.id);
        } catch (e) {
          // Keep this server's last good answer instead of wiping its badges.
          lastErrors.set(server.id, { at: new Date(), message: e.message });
          logger.warn('Could not read the deletion schedule from Maintainerr', {
            label: 'Maintainerr',
            server: server.name,
            errorMessage: e.message,
          });
        }
      }

      refreshedOnce = true;
    })().finally(() => {
      inFlight = null;
    });
  }

  return inFlight;
};

/**
 * Last attempt time of the least recently asked server; 0 if one was never
 * asked.
 */
const oldestAttempt = (): number =>
  Math.min(
    ...configuredServers().map((server) => attemptedAt.get(server.id) ?? 0),
    Date.now()
  );

const ensureFresh = async (): Promise<void> => {
  if (!refreshedOnce) {
    await refreshDeletingSoon();
    return;
  }

  // Go by last attempt, not last answer, so an unreachable server is retried
  // after the same wait instead of on every call (or never).
  if (Date.now() - oldestAttempt() > REFRESH_AFTER_MS) {
    // Answer from what we have; refresh in the background.
    void refreshDeletingSoon();
  }
};

/** Every server's plan for one title. */
const holdsFor = (key: string): Hold[] =>
  [...snapshots.values()].flatMap((snapshot) => {
    const entry = snapshot.entries.get(key);
    return entry ? [entry] : [];
  });

const allKeys = (): Set<string> =>
  new Set([...snapshots.values()].flatMap((s) => [...s.entries.keys()]));

/**
 * Reduces a title's plans to what users see: the soonest deletion within its
 * server's "soon" window, and the features those servers allow.
 */
const toItem = (key: string): DeletingSoonItem | undefined => {
  const servers = new Map(configuredServers().map((s) => [s.id, s]));
  const now = Date.now();

  const imminent = holdsFor(key).filter((hold) => {
    const server = servers.get(hold.serverId);
    return (
      !!server && hold.deleteAt.getTime() <= now + server.soonDays * DAY_MS
    );
  });

  if (imminent.length === 0) {
    return undefined;
  }

  const [mediaType, tmdbId] = key.split(':');
  const imminentServers = imminent.map((hold) => servers.get(hold.serverId)!);

  return {
    tmdbId: Number(tmdbId),
    mediaType: mediaType as VideoMediaType,
    deleteAt: new Date(
      Math.min(...imminent.map((hold) => hold.deleteAt.getTime()))
    ),
    showBadge: imminentServers.some((server) => server.showBadges),
    showInRow: imminentServers.some((server) => server.showDeletingSoon),
    canKeep: imminentServers.every((server) => server.allowKeep),
  };
};

/** Everything due soon on any server, soonest first. */
export const getDeletingSoon = async (): Promise<DeletingSoonItem[]> => {
  if (!isMaintainerrConfigured()) {
    return [];
  }

  await ensureFresh();

  return [...allKeys()]
    .map(toItem)
    .filter((item): item is DeletingSoonItem => !!item)
    .sort((a, b) => a.deleteAt.getTime() - b.deleteAt.getTime());
};

export class NotScheduledError extends Error {}
export class KeepNotAllowedError extends Error {}

/**
 * Keeps a title by postponing it in every rule on every server that would
 * delete it; postponing in only one would let another delete it anyway.
 */
export const keepTitle = async (
  mediaType: MediaType,
  tmdbId: number,
  keptBy: string,
  keptById?: number
): Promise<DeletingSoonItem | undefined> => {
  const key = keyOf(mediaType, tmdbId);
  await ensureFresh();

  let item = toItem(key);
  // It may have joined a rule since: refresh, at most once a minute.
  if (!item && Date.now() - oldestAttempt() > MISS_REFRESH_AFTER_MS) {
    await refreshDeletingSoon();
    item = toItem(key);
  }

  if (!item) {
    throw new NotScheduledError('This title is not scheduled for deletion.');
  }

  if (!item.canKeep) {
    throw new KeepNotAllowedError('Keeping this title is turned off.');
  }

  const servers = new Map(configuredServers().map((s) => [s.id, s]));
  const keptOn: string[] = [];

  for (const hold of holdsFor(key)) {
    const server = servers.get(hold.serverId);

    // Skip servers that disallow Keep, even when their deletion is too far
    // off to stop Keep being offered.
    if (!server?.allowKeep) {
      continue;
    }

    const api = new MaintainerrAPI(server);
    for (const collection of hold.collections) {
      await api.postpone(
        collection.id,
        collection.mediaServerId,
        server.keepDays > 0 ? server.keepDays : undefined
      );
    }

    logger.info('Kept a title from deletion', {
      label: 'Maintainerr',
      server: server.name,
      mediaType,
      tmdbId,
      keptBy,
      rules: hold.collections.map((collection) => collection.title),
    });
    keptOn.push(server.name);
  }

  await recordMediaEvent({
    tmdbId,
    mediaType,
    type: MediaEventType.KEPT,
    userId: keptById,
    detail: keptOn.filter(Boolean).join(', '),
  });

  await refreshDeletingSoon();
  return toItem(key);
};

/** For the health page: one entry per server. */
export const getMaintainerrStatus = () =>
  configuredServers().map((server) => ({
    id: server.id,
    name: server.name,
    lastRefreshedAt: snapshots.has(server.id)
      ? new Date(snapshots.get(server.id)!.fetchedAt)
      : null,
    scheduled: snapshots.get(server.id)?.entries.size ?? 0,
    lastError: lastErrors.get(server.id) ?? null,
  }));

/** Tests only. */
export const resetDeletingSoonForTests = () => {
  snapshots.clear();
  lastErrors.clear();
  attemptedAt.clear();
  refreshedOnce = false;
  inFlight = null;
};
