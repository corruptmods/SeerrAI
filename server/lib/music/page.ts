/** The furthest page a music list is read to: far past any real one. */
export const MOST_PAGES = 10_000;

/**
 * The page asked for: a whole number from 1, 1 for anything else, and no
 * further than `most`, so an offset stays a number a database or
 * MusicBrainz takes.
 */
export const pageOf = (value: unknown, most = MOST_PAGES): number => {
  const page = Math.floor(Number(value));
  return Number.isFinite(page) && page >= 1 ? Math.min(page, most) : 1;
};
