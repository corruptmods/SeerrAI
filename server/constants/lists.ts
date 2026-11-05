// Watch list tuning knobs, the ones most likely to need adjusting against a
// real library.

/** Poster paths fetched per overview load for items that have none stored. */
export const POSTER_BACKFILL_LIMIT = 60;

/** Max lines read from one pasted import, to bound its TMDB searches. */
export const IMPORT_LINE_LIMIT = 100;

/**
 * Max titles one import may add (a Trakt list, or a written list's matches).
 * Written lists stop at IMPORT_LINE_LIMIT lines first.
 */
export const IMPORT_ITEM_LIMIT = 500;

/** Titles resolved to TMDB matches per call, for a Trakt import. */
export const RESOLVE_BATCH_LIMIT = 25;

/**
 * Max titles one action may send to Radarr and Sonarr: a "request what's
 * missing" call, or an import's accompanying requests.
 */
export const REQUEST_BATCH_LIMIT = 20;

/** Matches offered per imported line. */
export const CANDIDATES_PER_LINE = 5;

/** Interval between re-checking a list against the server's watch history. */
export const WATCH_CHECK_INTERVAL_MS = 30 * 60 * 1000;
