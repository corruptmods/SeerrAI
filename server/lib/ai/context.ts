import TautulliAPI from '@server/api/tautulli';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { warmTmdbImages } from '@server/lib/imageproxy';
import { isCompletedPlay } from '@server/lib/listWatchRules';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapMovieResult, mapTvResult } from '@server/models/Search';
import { mapWithConcurrency } from '@server/utils/mapWithConcurrency';

/*
 * The little each feature tells the model about a person, and turning the
 * titles a model names back into real ones.
 */

/** Short, so "what I just watched" is what they just watched. */
const RECENT_MS = 5 * 60 * 1000;
const recent = new Map<number, { at: number; value: Activity }>();

/** Plays shorter than this are someone checking what a title is. */
const STARTED_PERCENT = 20;

export interface Activity {
  /** Where the titles came from: watch history, or failing that, requests. */
  source: 'watched' | 'requested' | 'none';
  /** Newest first. */
  items: { name: string; at?: number }[];
}

/**
 * What someone has been watching lately, newest first, as "Title (year)" for
 * films and "Title (series)" for shows: from Tautulli, counting a show they
 * are part-way through. Failing that, what they requested, marked as such so
 * it is never passed off as watched. Names only: nothing else about them
 * leaves the server.
 */
export const recentActivity = async (user: User): Promise<Activity> => {
  const hit = recent.get(user.id);
  if (hit && Date.now() - hit.at < RECENT_MS) {
    return hit.value;
  }

  const watched = new Map<string, number>();
  const tautulli = getSettings().tautulli;
  if (user.plexId && tautulli.hostname && tautulli.apiKey) {
    try {
      const history = await new TautulliAPI(tautulli).getUserHistory(user, 300);
      for (const record of history) {
        if (
          !isCompletedPlay(record) &&
          record.percent_complete < STARTED_PERCENT
        ) {
          continue;
        }
        const name =
          record.media_type === 'movie'
            ? `${record.title}${record.year ? ` (${record.year})` : ''}`
            : `${record.grandparent_title} (series)`;
        // Newest first from Tautulli, so the first play of a title is its
        // latest.
        if (!watched.has(name)) {
          watched.set(name, record.date);
        }
        if (watched.size >= 20) {
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

  let value: Activity;
  if (watched.size) {
    value = {
      source: 'watched',
      items: [...watched].map(([name, at]) => ({ name, at })),
    };
  } else {
    const requests = await getRepository(MediaRequest).find({
      where: { requestedBy: { id: user.id } },
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
    value = {
      source: names.length ? 'requested' : 'none',
      items: names.map((name) => ({ name })),
    };
  }

  recent.set(user.id, { at: Date.now(), value });
  return value;
};

/** Forget what was gathered, so the next answer asks again. */
export const forgetRecentActivity = () => recent.clear();

/** Just the names, for features that only need someone's taste. */
export const recentWatching = async (
  user: User,
  limit = 10
): Promise<string[]> =>
  (await recentActivity(user)).items.slice(0, limit).map((item) => item.name);

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
  /** movie or tv. */
  k: 'movie' | 'tv';
}

/** Posters fetched ahead: about what an answer shows before scrolling. */
const POSTERS_WARMED = 12;

type MappedResult =
  | ReturnType<typeof mapMovieResult>
  | ReturnType<typeof mapTvResult>;

/**
 * The TMDB entry for each title a model named, with this person's view of
 * its status (available, requested...), in the order named, without repeats.
 * A title TMDB cannot find is dropped rather than guessed.
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
 * TMDB titles as the app shows them, each with what the library knows of
 * it (status, requests), in the order given, without repeats.
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

  // The posters shown first start on their way now, while the rest of the
  // answer is put together, rather than once the browser has drawn the
  // cards. Only when posters are served from Seerr's own cache.
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

/** Cut to a length, on a word where possible. */
export const clip = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) {
    return clean;
  }
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
};
