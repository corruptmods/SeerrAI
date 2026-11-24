import type { User } from '@server/entity/User';
import {
  isCompletedPlay,
  STARTED_PERCENT,
  watchSource,
} from '@server/lib/watchHistory';
import logger from '@server/logger';

/*
 * What someone has already watched, so what is suggested to them can leave
 * it out. A film counts once finished or played past STARTED_PERCENT; a
 * series once any of its episodes does. Read from the media server's watch
 * history (Tautulli for Plex, the server itself for Jellyfin and Emby).
 *
 * Kept in memory per user and served stale while a fresh copy is read, so
 * nothing waits on it for long. It never throws: what could not be read is
 * left out, and the rest is still used.
 */

export interface Watched {
  /** "movie:<TMDB id>" and "tv:<TMDB id>". */
  keys: ReadonlySet<string>;
}

/** Plays read: as many as Suggested for You reads. */
const HISTORY_LENGTH = 3000;
/** Read again after this. */
const FRESH_MS = 30 * 60 * 1000;
/** People kept in memory; the least recently used go first. */
const MAX_PEOPLE = 500;
/** Longest an answer waits for what was watched before going without. */
export const WATCHED_WAIT_MS = 1500;

const EMPTY: Watched = { keys: new Set() };

/** The key a title has in the watched set. */
export const watchedKey = (mediaType: string, tmdbId: number) =>
  `${mediaType}:${tmdbId}`;

interface Entry {
  at: number;
  value: Watched;
}

/**
 * Keyed on the media server account as well as the user: history belongs to
 * the account, so relinking another one starts afresh.
 */
const cache = new Map<string, Entry>();
/** One read per key at a time; a second caller joins it. */
const inFlight = new Map<string, Promise<Watched>>();
/** Bumped by forgetWatched, so a read started before it is not kept. */
let generation = 0;

const keyOf = (user: User) =>
  `${user.id}:${watchSource()?.viewerOf(user) ?? ''}`;

/** TMDB keys of everything this user watched on the media server. */
const fromServer = async (user: User): Promise<Set<string>> => {
  const source = watchSource();
  if (!source || !source.viewerOf(user)) {
    return new Set();
  }
  const history = await source.history(user, HISTORY_LENGTH);
  const titleIds = new Set<string>();
  for (const play of history) {
    // Emby's undated plays (marked watched by hand) count too.
    if (
      play.titleId &&
      (isCompletedPlay(play) || play.percent >= STARTED_PERCENT)
    ) {
      titleIds.add(play.titleId);
    }
  }
  const media = await source.mediaFor([...titleIds]);
  return new Set(
    [...media.values()].map((item) => watchedKey(item.mediaType, item.tmdbId))
  );
};

const remember = (key: string, value: Watched) => {
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > MAX_PEOPLE) {
    cache.delete(cache.keys().next().value as string);
  }
};

/** Reads afresh, once per key at a time. Never rejects. */
const refresh = (user: User, key: string): Promise<Watched> => {
  const running = inFlight.get(key);
  if (running) {
    return running;
  }
  const started = generation;
  const previous = cache.get(key)?.value;
  const run = (async () => {
    const server = await fromServer(user).catch((e) => {
      logger.debug('Could not read watch history for what was watched', {
        label: 'Watched',
        userId: user.id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      // "Could not ask" is not "watched nothing": keep what was known.
      return new Set(previous?.keys ?? []);
    });
    const value: Watched = { keys: server };
    if (started === generation) {
      remember(key, value);
    }
    logger.debug('Read what was watched', {
      label: 'Watched',
      userId: user.id,
      titles: value.keys.size,
    });
    return value;
  })()
    .catch(() => previous ?? EMPTY)
    .finally(() => {
      if (inFlight.get(key) === run) {
        inFlight.delete(key);
      }
    });
  inFlight.set(key, run);
  return run;
};

/**
 * What this user has watched, read afresh when older than half an hour.
 * Never throws; whatever could not be read is left out.
 */
export const watchedFor = async (user: User): Promise<Watched> => {
  try {
    const key = keyOf(user);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < FRESH_MS) {
      // Most recently used goes last.
      cache.delete(key);
      cache.set(key, hit);
      return hit.value;
    }
    return await refresh(user, key);
  } catch {
    return EMPTY;
  }
};

/**
 * What is in memory for this user right now, without waiting: possibly
 * stale, undefined when nothing has been read yet. Starts a fresh read in
 * the background when due.
 */
export const watchedCached = (user: User): Watched | undefined => {
  try {
    const key = keyOf(user);
    const hit = cache.get(key);
    if (!hit || Date.now() - hit.at >= FRESH_MS) {
      void refresh(user, key);
    }
    return hit?.value;
  } catch {
    return undefined;
  }
};

/**
 * watchedFor, waiting at most `ms`: undefined if it takes longer, so a slow
 * server never holds up an answer.
 */
export const watchedWithin = (
  user: User,
  ms: number
): Promise<Watched | undefined> => awaitWithin(watchedFor(user), ms);

/** A pending read, waited on for at most `ms` more. */
export const awaitWithin = <T>(
  pending: Promise<T>,
  ms: number
): Promise<T | undefined> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      }
    );
  });

/** Forgets one user's watched titles, or everyone's. */
export const forgetWatched = (userId?: number) => {
  generation++;
  for (const map of [cache, inFlight] as Map<string, unknown>[]) {
    for (const key of [...map.keys()]) {
      if (userId === undefined || key.startsWith(`${userId}:`)) {
        map.delete(key);
      }
    }
  }
};

/**
 * The results not yet watched. Takes app results (mediaType) and TMDB
 * results (media_type) alike.
 */
export const dropWatched = <
  T extends { id: number; mediaType?: string; media_type?: string },
>(
  keys: ReadonlySet<string> | undefined,
  results: T[]
): T[] =>
  keys?.size
    ? results.filter(
        (result) =>
          !keys.has(
            watchedKey(result.mediaType ?? result.media_type ?? '', result.id)
          )
      )
    : results;
