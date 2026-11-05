/**
 * A TMDB image path as TMDB issues them ("/kqjL17yufvn9OVLyXYpvtyrFfak.jpg"),
 * or null. Browser-supplied paths are checked with this before storing, since
 * other users' pages build image URLs from them.
 */
export const tmdbImagePath = (value: unknown): string | null =>
  typeof value === 'string' &&
  /^\/[A-Za-z0-9_-]{1,64}\.(?:jpe?g|png|webp|svg)$/.test(value)
    ? value
    : null;
