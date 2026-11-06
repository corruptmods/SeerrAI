// "Your Watchlist" orders: newest added first, oldest first, or by title.
// Without one, a watchlist keeps the order it always had: Plex's own, or the
// order added for one kept here (Jellyfin, Emby and local users).
//
// Shared with the page, so it imports nothing.

export const WATCHLIST_SORTS = ['added-desc', 'added-asc', 'title'] as const;

export type WatchlistSort = (typeof WATCHLIST_SORTS)[number];

/** The order asked for, if it is one. */
export const watchlistSortOf = (value: unknown): WatchlistSort | undefined =>
  WATCHLIST_SORTS.includes(value as WatchlistSort)
    ? (value as WatchlistSort)
    : undefined;
