/** Highest page a music list reads; far past any real one. */
export const MOST_PAGES = 10_000;

/**
 * Parses a page number: an integer from 1 (else 1), capped at `most` so the
 * offset stays valid for the database and MusicBrainz.
 */
export const pageOf = (value: unknown, most = MOST_PAGES): number => {
  const page = Math.floor(Number(value));
  return Number.isFinite(page) && page >= 1 ? Math.min(page, most) : 1;
};
