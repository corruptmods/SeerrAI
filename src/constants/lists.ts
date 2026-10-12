/** Tuning for the watch list interface. */

/** Tiles across a list card's poster mosaic. */
export const TILE_COUNT = 3;

/** How long each poster in a card's tile is shown before the next. */
export const SECONDS_PER_POSTER = 4.5;

/** How long the next poster takes to fade in over the last. */
export const CROSSFADE_SECONDS = 1.1;

/**
 * The poster size a card's tiles use: a third of a card, sharp on a phone's
 * screen, and a good deal smaller to fetch than the full-size poster.
 */
export const LIST_POSTER_SIZE = 'w342';

/** Lines searched per request when matching a pasted import. */
export const SEARCH_BATCH_SIZE = 8;

/** Trakt titles matched by TMDB id per request, when importing a Trakt list. */
export const RESOLVE_BATCH_SIZE = 25;
