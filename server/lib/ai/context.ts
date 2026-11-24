import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import { MediaType, VIDEO_MEDIA_TYPES } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { warmTmdbImages } from '@server/lib/imageproxy';
import { getSettings } from '@server/lib/settings';
import type { TraktRecent } from '@server/lib/watched';
import { traktNameOf, watchedCached, watchedKey } from '@server/lib/watched';
import type { WatchSource } from '@server/lib/watchHistory';
import {
  isCompletedPlay,
  STARTED_PERCENT,
  watchSource,
} from '@server/lib/watchHistory';
import logger from '@server/logger';
import { mapMovieResult, mapTvResult } from '@server/models/Search';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';
import { In } from 'typeorm';

/*
 * What each feature tells the model about a user, and mapping the titles a
 * model names back to real ones.
 */

/** Short, so "what I just watched" stays current. */
const RECENT_MS = 5 * 60 * 1000;
/** By user and media server account, as suggestions are. */
const recent = new Map<string, { at: number; value: Activity }>();
/** Longest title taken from watch history. */
const MAX_PLAYED_TITLE = 200;

export interface Activity {
  /** Watch history, or requests when there is none. */
  source: 'watched' | 'requested' | 'none';
  /** Newest first. */
  items: ActivityItem[];
  /**
   * Just the server's own (or requests), in its own order: Trakt never
   * crowds these out.
   */
  server: ActivityItem[];
}

interface ActivityItem {
  name: string;
  /** Unset when the server does not say when. */
  at?: number;
  /** Seerr's own media server (or requests), or the person's Trakt. */
  from: 'server' | 'trakt';
}

/** Titles of recent watching kept. */
const RECENT_TITLES = 20;

/**
 * A comparison key ignoring a trailing year or "(series)", case and
 * punctuation: "Harbour Lights (2005)" and "harbour lights (series)" match.
 */
export const nameKey = (name: string) =>
  name
    .replace(/\s*\((?:series|\d{4})\)\s*$/i, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** "Title (year)" for a film, "Title (series)" for a series. */
const named = (kind: 'movie' | 'tv', title: string, year?: number) =>
  kind === 'movie'
    ? `${title}${year ? ` (${year})` : ''}`
    : `${title} (series)`;

/**
 * Recent watching, newest first, as "Title (year)" or "Title (series)", from
 * watch history (Tautulli for Plex, the server itself for Jellyfin and Emby),
 * including shows part-way through, and, once an admin turns it on, what
 * they watched on Trakt as last read (never waited for). Falls back to
 * requests, marked so they are never passed off as watched. Only names
 * leave the server.
 */
export const recentActivity = async (user: User): Promise<Activity> => {
  const source = watchSource();
  const viewer = source?.viewerOf(user);
  const traktName = traktNameOf(user);
  const key = `${user.id}:${viewer ?? ''}:${traktName ?? ''}`;
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < RECENT_MS) {
    return hit.value;
  }

  // By name: its latest play and the server's id for the title.
  const watched = new Map<string, { at: number; titleId: string }>();
  if (source && viewer) {
    try {
      const history = await source.history(user, 300);
      for (const play of history) {
        if (!isCompletedPlay(play) && play.percent < STARTED_PERCENT) {
          continue;
        }
        // Media server text, kept to one plain line.
        const title = clip(play.title, MAX_PLAYED_TITLE);
        if (!title) {
          continue;
        }
        const name = named(
          play.kind === 'movie' ? 'movie' : 'tv',
          title,
          play.year
        );
        // History is newest first, so a title's first play is its latest.
        if (!watched.has(name)) {
          watched.set(name, { at: play.at, titleId: play.titleId });
        }
        if (watched.size >= RECENT_TITLES) {
          break;
        }
      }
    } catch (e) {
      logger.debug('No watch history for AI context', {
        label: 'AI',
        userId: user.id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const serverItems: Activity['items'] = [...watched].map(([name, { at }]) => ({
    name,
    // A play with no date (Emby) is undated, not the oldest.
    ...(at ? { at } : {}),
    from: 'server' as const,
  }));
  let items = serverItems;
  // Trakt as last read; nothing read yet means asking again next time.
  const trakt = traktName ? watchedCached(user) : undefined;
  if (trakt?.traktRecent.length) {
    items = mergeNewestFirst(
      serverItems,
      await traktNotOnServer(source, watched, trakt.traktRecent)
    ).slice(0, RECENT_TITLES);
  }

  let value: Activity;
  if (items.length) {
    value = { source: 'watched', items, server: serverItems };
  } else {
    const requests = await getRepository(MediaRequest).find({
      where: { requestedBy: { id: user.id }, type: In(VIDEO_MEDIA_TYPES) },
      relations: { media: true },
      order: { createdAt: 'DESC' },
      take: 10,
    });
    const tmdb = new TheMovieDb();
    const found = await mapWithConcurrency(requests, 4, async (request) => {
      try {
        return request.media.mediaType === MediaType.MOVIE
          ? (await tmdb.getMovie({ movieId: request.media.tmdbId })).title
          : `${(await tmdb.getTvShow({ tvId: request.media.tmdbId })).name} (series)`;
      } catch {
        return undefined;
      }
    });
    const names = [...new Set(found.filter((name): name is string => !!name))];
    const requested = names.map((name) => ({
      name,
      from: 'server' as const,
    }));
    value = {
      source: names.length ? 'requested' : 'none',
      items: requested,
      server: requested,
    };
  }

  if (!traktName || trakt) {
    recent.set(key, { at: Date.now(), value });
  }
  return value;
};

/**
 * The server's titles and Trakt's, newest first. The server's keep their own
 * order, and one with no date stays where the server put it rather than
 * sorting as the oldest.
 */
export const mergeNewestFirst = (
  server: Activity['items'],
  trakt: Activity['items']
): Activity['items'] => {
  const byDate = [...trakt].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const merged: Activity['items'] = [];
  let s = 0;
  let t = 0;
  while (s < server.length || t < byDate.length) {
    const own = server[s];
    const theirs = byDate[t];
    if (own && (!theirs || !own.at || own.at >= (theirs.at ?? 0))) {
      merged.push(own);
      s++;
    } else {
      merged.push(theirs);
      t++;
    }
  }
  return merged;
};

/**
 * Trakt's recent titles not already in the server's: the same TMDB title,
 * else the same name. One library lookup for the server's titles.
 */
const traktNotOnServer = async (
  source: WatchSource | undefined,
  server: Map<string, { titleId: string }>,
  recentOnTrakt: readonly TraktRecent[]
): Promise<Activity['items']> => {
  const serverKeys = new Set<string>();
  if (source && server.size) {
    try {
      const media = await source.mediaFor(
        [...server.values()].map(({ titleId }) => titleId)
      );
      for (const item of media.values()) {
        serverKeys.add(watchedKey(item.mediaType, item.tmdbId));
      }
    } catch {
      // Names alone still catch most.
    }
  }
  const names = new Set([...server.keys()].map(nameKey));
  const items: Activity['items'] = [];
  for (const title of recentOnTrakt) {
    // Trakt text, kept to one plain line.
    const clean = clip(title.title, MAX_PLAYED_TITLE);
    const name = clean && named(title.kind, clean, title.year);
    if (
      !name ||
      (title.key && serverKeys.has(title.key)) ||
      names.has(nameKey(name))
    ) {
      continue;
    }
    names.add(nameKey(name));
    if (title.key) {
      serverKeys.add(title.key);
    }
    items.push({ name, at: title.at, from: 'trakt' });
  }
  return items;
};

/** Clears the cache so the next answer refetches. */
export const forgetRecentActivity = () => recent.clear();

/**
 * Just the names, for features that only need someone's taste; with
 * `serverOnly`, leaving out what was watched on Trakt.
 */
export const recentWatching = async (
  user: User,
  limit = 10,
  { serverOnly = false }: { serverOnly?: boolean } = {}
): Promise<string[]> =>
  (await recentActivity(user))[serverOnly ? 'server' : 'items']
    .slice(0, limit)
    .map((item) => item.name);

/** "today", "yesterday", "3 days ago", "5 weeks ago", roughly. */
export const ago = (at: number, now = Date.now()) => {
  const days = Math.floor((now / 1000 - at) / 86_400);
  if (days < 1) {
    return 'today';
  }
  if (days < 2) {
    return 'yesterday';
  }
  if (days < 14) {
    return `${days} days ago`;
  }
  if (days < 60) {
    return `${Math.floor(days / 7)} weeks ago`;
  }
  return `${Math.floor(days / 30)} months ago`;
};

export interface NamedTitle {
  /** Title. */
  t: string;
  /** Year of first release, if the model knows it. */
  y?: number | null;
  k: 'movie' | 'tv';
}

/** Posters prefetched: about what an answer shows before scrolling. */
const POSTERS_WARMED = 12;

type MappedResult =
  | ReturnType<typeof mapMovieResult>
  | ReturnType<typeof mapTvResult>;

/**
 * The TMDB entry for each title the model named, with this user's status,
 * in order and deduplicated. A title TMDB cannot find is dropped, not
 * guessed.
 */
export const resolveTitles = async (
  user: User,
  named: NamedTitle[]
): Promise<MappedResult[]> => {
  const tmdb = new TheMovieDb();
  const found = await mapWithConcurrency(named, 4, async (title) => {
    const search = async (year?: number) =>
      title.k === 'movie'
        ? (await tmdb.searchMovies({ query: title.t, year })).results[0]
        : (await tmdb.searchTvShows({ query: title.t, year })).results[0];
    try {
      const year = title.y ?? undefined;
      const result = (await search(year)) ?? (year ? await search() : null);
      return result ? { kind: title.k, result } : null;
    } catch {
      return null;
    }
  });

  return withLibraryStatus(
    user,
    found.filter((f): f is NonNullable<typeof f> => !!f)
  );
};

/**
 * TMDB titles as the app shows them, with library status and requests, in
 * order and deduplicated.
 */
export const withLibraryStatus = async (
  user: User,
  found: {
    kind: 'movie' | 'tv';
    result: TmdbMovieResult | TmdbTvResult;
  }[]
): Promise<MappedResult[]> => {
  const seen = new Set<string>();
  const unique = found.filter(
    (f) =>
      !seen.has(`${f.kind}:${f.result.id}`) &&
      !!seen.add(`${f.kind}:${f.result.id}`)
  );

  // Prefetch the first posters while the answer is assembled, not after the
  // browser draws the cards. Only when Seerr serves cached images.
  if (getSettings().main.cacheImages) {
    warmTmdbImages(
      unique
        .slice(0, POSTERS_WARMED)
        .map((f) => f.result.poster_path)
        .filter((path): path is string => !!path)
        .map((path) => `/t/p/w300_and_h450_face${path}`)
    );
  }

  const media = await Media.getRelatedMedia(
    user,
    unique.map((f) => ({
      tmdbId: f.result.id,
      mediaType: f.kind === 'movie' ? MediaType.MOVIE : MediaType.TV,
    })),
    { includeActiveRequest: true }
  );
  const related = (kind: 'movie' | 'tv', id: number) =>
    media.find(
      (m) =>
        m.tmdbId === id &&
        m.mediaType === (kind === 'movie' ? MediaType.MOVIE : MediaType.TV)
    );

  return unique.map((f) =>
    f.kind === 'movie'
      ? mapMovieResult(
          f.result as TmdbMovieResult,
          related('movie', f.result.id)
        )
      : mapTvResult(f.result as TmdbTvResult, related('tv', f.result.id))
  );
};

/** "Title (year)" for a TMDB result, for prompts. */
export const label = (
  result: { title?: string; name?: string } & {
    release_date?: string;
    first_air_date?: string;
  }
) => {
  const name = result.title ?? result.name ?? '?';
  const year = (result.release_date ?? result.first_air_date ?? '').slice(0, 4);
  return year ? `${name} (${year})` : name;
};

/** Truncates to `max`, at a word boundary where possible. */
export const clip = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) {
    return clean;
  }
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
};
