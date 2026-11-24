import TraktAPI, { TraktError } from '@server/api/trakt';
import type { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
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
 * history (Tautulli for Plex, the server itself for Jellyfin and Emby) and,
 * once an admin turns it on, from the person's public Trakt profile.
 *
 * Kept in memory per user and served stale while a fresh copy is read, so
 * nothing waits on it for long. It never throws: what could not be read is
 * left out, and the rest is still used. The media server and Trakt fail
 * apart.
 */

/** A title someone watched on Trakt, for their taste. */
export interface TraktRecent {
  title: string;
  year?: number;
  kind: 'movie' | 'tv';
  /** Their latest play, in Unix seconds. */
  at: number;
  /** Its key in the watched set; missing when Trakt has no TMDB id. */
  key?: string;
}

export interface Watched {
  /** "movie:<TMDB id>" and "tv:<TMDB id>". */
  keys: ReadonlySet<string>;
  /** What they watched most recently on Trakt, newest first. */
  traktRecent: readonly TraktRecent[];
}

/** Plays read: as many as Suggested for You reads. */
const HISTORY_LENGTH = 3000;
/** Read again after this. */
const FRESH_MS = 30 * 60 * 1000;
/** People kept in memory; the least recently used go first. */
const MAX_PEOPLE = 500;
/** Longest an answer waits for what was watched before going without. */
export const WATCHED_WAIT_MS = 1500;
/** Recent Trakt titles kept. */
const TRAKT_RECENT = 20;
/** A private profile or wrong name lasts until fixed: asked again after. */
const TRAKT_LASTING_PAUSE_MS = 6 * 60 * 60 * 1000;
/** Trakt busy or down: asked again after. */
const TRAKT_PASSING_PAUSE_MS = 15 * 60 * 1000;
const TRAKT_WARN_MS = 60 * 60 * 1000;

const EMPTY: Watched = { keys: new Set(), traktRecent: [] };

/** The key a title has in the watched set. */
export const watchedKey = (mediaType: string, tmdbId: number) =>
  `${mediaType}:${tmdbId}`;

/** What one source gave, kept apart so each can fail on its own. */
interface Part {
  keys: ReadonlySet<string>;
  recent: readonly TraktRecent[];
}

const NOTHING: Part = { keys: new Set(), recent: [] };

interface Entry {
  at: number;
  server: Part;
  trakt: Part;
  value: Watched;
}

/**
 * Keyed on the media server account and Trakt name as well as the user:
 * history belongs to the account, so relinking another one starts afresh.
 */
const cache = new Map<string, Entry>();
/** One read per key at a time; a second caller joins it. */
const inFlight = new Map<string, Promise<Watched>>();
/**
 * Bumped by forgetWatched, so a read started before it is not kept: for
 * everyone at once, or for one user, whose other readers are left alone.
 */
let everyone = 0;
const forgotten = new Map<number, number>();
const generationOf = (userId: number) =>
  everyone + (forgotten.get(userId) ?? 0);
/** Users whose Trakt is not asked about until then, after a failure. */
const traktPaused = new Map<number, number>();
/** When each user was last warned about their Trakt profile. */
const traktWarned = new Map<number, number>();

/**
 * The Trakt name whose history counts for this user: only once an admin
 * turned Trakt history on and the person gave one.
 */
export const traktNameOf = (user: User): string | undefined => {
  const { clientId, watchHistory } = getSettings().trakt ?? {};
  return (
    (clientId && watchHistory && user.settings?.traktUsername) || undefined
  );
};

const keyOf = (user: User) =>
  `${user.id}:${watchSource()?.viewerOf(user) ?? ''}:${traktNameOf(user) ?? ''}`;

/** TMDB keys of everything this user watched on the media server. */
const fromServer = async (user: User): Promise<Part> => {
  const source = watchSource();
  if (!source || !source.viewerOf(user)) {
    return NOTHING;
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
  return {
    keys: new Set(
      [...media.values()].map((item) => watchedKey(item.mediaType, item.tmdbId))
    ),
    recent: [],
  };
};

/**
 * What the user watched on Trakt. A failure pauses asking for a while;
 * until then, the last answer stands.
 */
const fromTrakt = async (
  user: User,
  name: string,
  previous: Part | undefined
): Promise<Part> => {
  const clientId = getSettings().trakt.clientId;
  if (!clientId || Date.now() < (traktPaused.get(user.id) ?? 0)) {
    return previous ?? NOTHING;
  }
  try {
    const trakt = new TraktAPI(clientId);
    const [movies, shows] = await Promise.all([
      trakt.watchedMovies(name),
      trakt.watchedShows(name),
    ]);
    traktPaused.delete(user.id);
    traktWarned.delete(user.id);
    const titles: TraktRecent[] = [...movies, ...shows].map((title) => {
      const kind = title.type === 'movie' ? 'movie' : 'tv';
      return {
        title: title.title,
        year: title.year,
        kind,
        at: title.lastWatchedAt ?? 0,
        key: title.tmdbId ? watchedKey(kind, title.tmdbId) : undefined,
      };
    });
    return {
      keys: new Set(titles.flatMap((title) => (title.key ? [title.key] : []))),
      recent: titles
        .filter((title) => title.at > 0)
        .sort((a, b) => b.at - a.at)
        .slice(0, TRAKT_RECENT),
    };
  } catch (e) {
    const problem = e instanceof TraktError ? e.problem : 'unreachable';
    const lasting = ['private', 'notFound', 'badKey'].includes(problem);
    traktPaused.set(
      user.id,
      Date.now() + (lasting ? TRAKT_LASTING_PAUSE_MS : TRAKT_PASSING_PAUSE_MS)
    );
    // Messages can carry the Trakt name; only the kind of problem is logged.
    const last = traktWarned.get(user.id) ?? 0;
    if (lasting && Date.now() - last >= TRAKT_WARN_MS) {
      traktWarned.set(user.id, Date.now());
      logger.warn(
        'Could not read what someone watched on Trakt. Their Trakt profile must be public, under the name in their profile settings',
        { label: 'Watched', userId: user.id, problem }
      );
    } else {
      logger.debug('Could not read what someone watched on Trakt', {
        label: 'Watched',
        userId: user.id,
        problem,
      });
    }
    return previous ?? NOTHING;
  }
};

const remember = (key: string, entry: Entry) => {
  cache.delete(key);
  cache.set(key, entry);
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
  const started = generationOf(user.id);
  const previous = cache.get(key);
  const traktName = traktNameOf(user);
  const run = (async () => {
    const [server, trakt] = await Promise.all([
      fromServer(user).catch((e) => {
        logger.debug('Could not read watch history for what was watched', {
          label: 'Watched',
          userId: user.id,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        // "Could not ask" is not "watched nothing": keep what was known.
        return previous?.server ?? NOTHING;
      }),
      traktName ? fromTrakt(user, traktName, previous?.trakt) : NOTHING,
    ]);
    const value: Watched = {
      keys: new Set([...server.keys, ...trakt.keys]),
      traktRecent: trakt.recent,
    };
    if (started === generationOf(user.id)) {
      remember(key, { at: Date.now(), server, trakt, value });
    }
    logger.debug('Read what was watched', {
      label: 'Watched',
      userId: user.id,
      fromServer: server.keys.size,
      fromTrakt: trakt.keys.size,
    });
    return value;
  })()
    .catch(() => previous?.value ?? EMPTY)
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
    if (hit) {
      // Most recently used goes last, so a title read often is not the
      // first to go.
      cache.delete(key);
      cache.set(key, hit);
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

/**
 * Forgets one user's watched titles, or everyone's, and asks Trakt again
 * next time even after a failure.
 */
export const forgetWatched = (userId?: number) => {
  if (userId === undefined) {
    everyone++;
    traktPaused.clear();
    traktWarned.clear();
  } else {
    forgotten.set(userId, (forgotten.get(userId) ?? 0) + 1);
    traktPaused.delete(userId);
    traktWarned.delete(userId);
  }
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
