import { mutate } from 'swr';

/*
 * Watchlists are shown in a new order each visit: the home row, a profile's
 * row and the watchlist page share one seed, so the page opened from a row
 * starts with the titles the row showed. Coming back within a few minutes
 * keeps the order, so a row just scrolled through isn't mixed again.
 */

const KEEP_MS = 10 * 60_000;
let current: { seed: number; at: number } | undefined;

export const watchlistSeed = (): number => {
  const now = Date.now();
  if (!current || now - current.at > KEEP_MS) {
    current = { seed: Math.floor(Math.random() * 2 ** 32), at: now };
  }
  return current.seed;
};

export const HOME_WATCHLIST = '/api/v1/discover/watchlist';

/** Reads the home watchlist row again, in whatever order it is shown. */
export const refreshHomeWatchlist = () =>
  mutate((key) => typeof key === 'string' && key.startsWith(HOME_WATCHLIST));
