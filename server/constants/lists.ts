/**
 * Tuning for the watch list features.
 *
 * Collected here because these were scattered across six files and are the
 * knobs most likely to need adjusting against a real library.
 */

/** Poster paths fetched per overview load for items that have none stored. */
export const POSTER_BACKFILL_LIMIT = 60;

/** Lines read from one pasted import, to bound the TMDB searches it costs. */
export const IMPORT_LINE_LIMIT = 100;

/**
 * Titles one import may add to a list: a Trakt list, or what a written list
 * matched. Written lists stop at IMPORT_LINE_LIMIT lines before this.
 */
export const IMPORT_ITEM_LIMIT = 500;

/** Titles resolved to TMDB matches in one call, for a Trakt import. */
export const RESOLVE_BATCH_LIMIT = 25;

/**
 * Titles one action may send to Radarr and Sonarr: a "request what's
 * missing" call, or the requests that ride along with an import.
 */
export const REQUEST_BATCH_LIMIT = 20;

/** Matches offered per imported line. */
export const CANDIDATES_PER_LINE = 5;

/** How long between re-checking a list against the server's watch history. */
export const WATCH_CHECK_INTERVAL_MS = 30 * 60 * 1000;
