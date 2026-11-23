import TheMovieDb from '@server/api/themoviedb';
import type { TmdbFilmDate } from '@server/lib/backfill/plan';
import {
  filmIsOut,
  filmOutAWhile,
  radarrHasNoDate,
  tmdbFilmDate,
} from '@server/lib/backfill/plan';
import type { RadarrMovieDetail } from '@server/lib/backfill/radarr';
import logger from '@server/logger';

/*
 * Whether a film is out, for Backfill's scan, a title's Backfill page and the
 * admin agent alike. Radarr counts a film with no cinema, digital or physical
 * date as never available (a film made for TV has only a TV release on
 * TMDB), so it never searches for it; Backfill then goes by TMDB's date.
 * TMDB is asked only for such films, and its answer kept for a day.
 */

const KEEP_MS = 24 * 60 * 60_000;
/** After TMDB fails to answer, before asking again. */
const RETRY_MS = 60 * 60_000;

const known = new Map<
  number,
  { date: TmdbFilmDate | undefined; until: number }
>();

/** TMDB's release date for a film, kept for a day. */
export const tmdbReleaseOf = async (
  tmdbId: number
): Promise<TmdbFilmDate | undefined> => {
  const held = known.get(tmdbId);
  if (held && held.until > Date.now()) return held.date;
  try {
    const details = await new TheMovieDb().getMovie({ movieId: tmdbId });
    const date = tmdbFilmDate(details);
    known.set(tmdbId, { date, until: Date.now() + KEEP_MS });
    return date;
  } catch (e) {
    logger.debug('Backfill could not read a film’s release dates from TMDB', {
      label: 'Backfill',
      tmdbId,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    known.set(tmdbId, { date: undefined, until: Date.now() + RETRY_MS });
    return undefined;
  }
};

/** Forgets what TMDB said; for tests. */
export const forgetFilmDates = (): void => known.clear();

export interface FilmOut {
  /** Out long enough for Backfill to fetch it. */
  out: boolean;
  /** TMDB's date, when Radarr has none and Backfill goes by it. */
  tmdb?: TmdbFilmDate;
}

/**
 * Whether Backfill counts the film as out: Radarr's verdict, or TMDB's date
 * when Radarr has no date for it, each counted with the new-release wait.
 */
export const filmOut = async (movie: RadarrMovieDetail): Promise<FilmOut> => {
  if (movie.isAvailable) return { out: filmOutAWhile(movie) };
  if (!radarrHasNoDate(movie) || !movie.tmdbId) return { out: false };
  // A film whose year is still to come isn't out, whatever TMDB says.
  if (movie.year && movie.year > new Date().getUTCFullYear()) {
    return { out: false };
  }
  const tmdb = await tmdbReleaseOf(movie.tmdbId);
  return { out: filmIsOut(movie, tmdb?.date), tmdb };
};
