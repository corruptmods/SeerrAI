/**
 * A TMDB image path as TMDB hands them out ("/kqjL17yufvn9OVLyXYpvtyrFfak.jpg"),
 * or null. Paths that arrive from a browser are checked with this before they
 * are stored, because other people's pages build image addresses from them.
 */
export const tmdbImagePath = (value: unknown): string | null =>
  typeof value === 'string' &&
  /^\/[A-Za-z0-9_-]{1,64}\.(?:jpe?g|png|webp|svg)$/.test(value)
    ? value
    : null;
