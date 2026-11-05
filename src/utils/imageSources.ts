import { IMAGE_FORMATS, IMAGE_WIDTHS } from '@server/constants/images';

/** Images at least this wide also get smaller proxy widths, so phones skip desktop sizes. */
const RESPONSIVE_FROM = 1000;

/**
 * Artist backdrops: fanart.tv 1920, TheAudioDB 1280. The proxy never upscales,
 * so the wider is free.
 */
const ARTIST_BACKDROP_WIDTH = 1920;

/**
 * Artist photos: fanart.tv's are 1000 square. Shown in small tiles, so
 * smaller widths are offered; the proxy never upscales.
 */
const ARTIST_PHOTO_WIDTH = 1000;

/**
 * The requested width of a proxied image (TMDB /t/p/w1920_and_h800..., a
 * cover's front-1200, an artist photo), or null if unknown.
 */
const widthOf = (url: string) => {
  const match =
    /^\/imageproxy\/tmdb\/t\/p\/w(\d+)/.exec(url) ??
    /^\/imageproxy\/caa\/.*\/front-(\d+)$/.exec(url);
  if (match) {
    return Number(match[1]);
  }
  const artist = /^\/imageproxy\/artist\/[^/?]+(\/backdrop)?$/.exec(url);
  if (artist) {
    return artist[1] ? ARTIST_BACKDROP_WIDTH : ARTIST_PHOTO_WIDTH;
  }
  return null;
};

/**
 * Whether the image proxy can convert an image: JPEG, PNG, album covers (no
 * file name in the URL) and artist photos.
 */
export const convertible = (url: string): boolean =>
  url.startsWith('/imageproxy/') &&
  (/\.(jpe?g|png)$/i.test(url) || /^\/imageproxy\/(caa|artist)\//.test(url));

/** A TMDB image URL: via Seerr's image cache when enabled, else TMDB directly. */
export const tmdbImageSrc = (src: string, cacheImages: boolean): string =>
  cacheImages && !src.startsWith('/')
    ? src.replace(/^https:\/\/image\.tmdb\.org\//, '/imageproxy/tmdb/')
    : src;

/**
 * Title page backdrop and poster URLs. Cards preload the same URLs (see
 * preloadPicture) so the page finds them cached.
 */
export const titleBackdrop = (backdropPath: string) =>
  `https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${backdropPath}`;

export const titlePoster = (posterPath: string) =>
  `https://image.tmdb.org/t/p/w600_and_h900_bestv2${posterPath}`;

/**
 * <source> entries for a proxied image: AVIF then WebP, with smaller widths
 * for wide images. Browsers supporting neither fall back to the <img>.
 */
export const sourcesFor = (url: string) => {
  const width = widthOf(url);
  const widths =
    width && width >= RESPONSIVE_FROM
      ? IMAGE_WIDTHS.filter((w) => w < width)
      : [];

  return IMAGE_FORMATS.map((format) => ({
    type: `image/${format}`,
    srcSet: widths.length
      ? [
          ...widths.map((w) => `${url}?f=${format}&w=${w} ${w}w`),
          `${url}?f=${format} ${width}w`,
        ].join(', ')
      : `${url}?f=${format}`,
    responsive: widths.length > 0,
  }));
};

/**
 * <link rel="preload"> attributes for an image. Names only the best format
 * with its type, and any widths as a srcset, so a browser that can't use
 * them fetches nothing rather than an unused copy.
 */
export const preloadFor = (
  url: string,
  sizes = '100vw'
): {
  href?: string;
  type?: string;
  imageSrcset?: string;
  imageSizes?: string;
} => {
  if (!convertible(url)) {
    return { href: url };
  }
  const [best] = sourcesFor(url);
  return best.responsive
    ? { type: best.type, imageSrcset: best.srcSet, imageSizes: sizes }
    : { type: best.type, href: best.srcSet };
};

const preloading = new Set<string>();

/**
 * Prefetches the next page's header image while the page loads. Only for an
 * image about to be shown (a page opened from a card).
 */
export const preloadPicture = (url: string, sizes?: string) => {
  if (typeof document === 'undefined') {
    return;
  }
  const attributes = preloadFor(url, sizes);
  const key = attributes.href ?? attributes.imageSrcset ?? '';
  if (!key || preloading.has(key)) {
    return;
  }
  preloading.add(key);

  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = 'image';
  link.fetchPriority = 'high';
  if (attributes.type) {
    link.type = attributes.type;
  }
  if (attributes.imageSrcset) {
    link.imageSrcset = attributes.imageSrcset;
    link.imageSizes = attributes.imageSizes ?? '';
  }
  if (attributes.href) {
    link.href = attributes.href;
  }
  // Once fetched, the browser cache holds it; the link can go.
  const done = () => {
    link.remove();
    preloading.delete(key);
  };
  link.addEventListener('load', done);
  link.addEventListener('error', done);
  document.head.appendChild(link);
};
