/**
 * Formats the image proxy converts posters and backdrops to, best first.
 * Browsers pick the first supported from CachedImage's <picture>.
 */
export const IMAGE_FORMATS = ['avif', 'webp'] as const;

export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/**
 * Extra widths the image proxy renders for smaller screens. Only ever smaller
 * than the original; a fixed few, so each image has a known handful of copies
 * on disk.
 */
export const IMAGE_WIDTHS = [480, 780, 1280] as const;

export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

/** Image cache size before least used images are evicted. */
export const DEFAULT_IMAGE_CACHE_MAX_MB = 2048;

/** The minimum settable limit; below it posters churn constantly. */
export const MIN_IMAGE_CACHE_MAX_MB = 256;
