/**
 * Formats the image proxy converts posters and backdrops to, best first. A
 * browser picks the first it supports from the <picture> CachedImage draws.
 */
export const IMAGE_FORMATS = ['avif', 'webp'] as const;

export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/**
 * Widths the image proxy also makes a picture in, for smaller screens. Only
 * ever smaller than the picture itself; a fixed few, so each picture has a
 * known handful of copies on disk.
 */
export const IMAGE_WIDTHS = [480, 780, 1280] as const;

export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

/** How big the image cache may grow before the least used are removed. */
export const DEFAULT_IMAGE_CACHE_MAX_MB = 2048;

/** The smallest limit that can be set; below it posters churn constantly. */
export const MIN_IMAGE_CACHE_MAX_MB = 256;
