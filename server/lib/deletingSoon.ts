import type { MaintainerrCollection } from '@server/api/maintainerr';
import MaintainerrAPI, { DELETING_ACTIONS } from '@server/api/maintainerr';
import { MediaType } from '@server/constants/media';
import { MediaEventType, recordMediaEvent } from '@server/lib/mediaHistory';
import type { MaintainerrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

/*
 * What each Maintainerr server is going to delete, and when, kept in memory.
 *
 * Each server's schedule is held separately: if one cannot be reached, its
 * last good answer is kept and the others carry on, and the error is recorded
 * for the health page. Refreshed whenever it is older than REFRESH_AFTER_MS
 * when someone asks.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 15 * 60 * 1000;

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
  mediaType: MediaType;
}

interface ServerSnapshot {
  fetchedAt: number;
  entries: Map<string, ServerEntry>;
}

/** A title as shown to people: soonest date, and what they may do. */
export interface DeletingSoonItem {
  tmdbId: number;
  mediaType: MediaType;
  deleteAt: Date;
  showBadge: boolean;
  showInRow: boolean;
  /**
   * Only when every server about to delete it allows Keep. Otherwise a Keep
   * would postpone one deletion while another still went ahead.
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
 * Whether a collection will actually delete its items. Season and episode
 * collections delete part of a show, so a "deleting" mark on the whole series
 * would be wrong; they are left out.
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

  // One at a time: a household has a handful of rules, and Maintainerr is not
  // built for bursts.
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

      // Forget servers that have been removed.
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
          // Keep this server's last good answer rather than wiping its
          // badges; the others are unaffected.
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

const ensureFresh = async (): Promise<void> => {
  if (!refreshedOnce) {
    await refreshDeletingSoon();
    return;
  }

  // By when each server was last asked, not last answered: one that cannot
  // be reached is tried again after the same wait, rather than on every call
  // (or, if it never answered, never). A server just added has not been
  // asked at all.
  const oldest = Math.min(
    ...configuredServers().map((server) => attemptedAt.get(server.id) ?? 0),
    Date.now()
  );

  if (Date.now() - oldest > REFRESH_AFTER_MS) {
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
 * Reduces one title's plans to what people see: the soonest deletion that
 * falls within its server's "soon" window, and the features those servers
 * allow.
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
    mediaType: mediaType as MediaType,
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
 * Keeps a title by postponing it in every rule, on every server, that would
 * delete it — postponing in only one would leave another to delete it anyway.
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
  if (!item) {
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

  for (const hold of holdsFor(key)) {
    const server = servers.get(hold.serverId);

    if (!server) {
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
  }

  await recordMediaEvent({
    tmdbId,
    mediaType,
    type: MediaEventType.KEPT,
    userId: keptById,
    detail: holdsFor(key)
      .map((hold) => servers.get(hold.serverId)?.name)
      .filter(Boolean)
      .join(', '),
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
