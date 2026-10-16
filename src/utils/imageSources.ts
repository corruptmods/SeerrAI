import { IMAGE_FORMATS, IMAGE_WIDTHS } from '@server/constants/images';

/**
 * Backdrops and other pictures at least this wide are also offered in the
 * proxy's smaller widths, so a phone does not download a desktop backdrop.
 */
const RESPONSIVE_FROM = 1000;

/**
 * An artist's backdrop: fanart.tv's are 1920 wide, TheAudioDB's 1280. The
 * proxy never makes a copy wider than the picture, so taking the wider of
 * the two costs nothing.
 */
const ARTIST_BACKDROP_WIDTH = 1920;

/**
 * A picture of an artist: fanart.tv's are 1000 square. Shown in tiles a few
 * hundred pixels wide, so smaller copies are offered too; the proxy makes
 * none wider than the picture, should one be smaller.
 */
const ARTIST_PHOTO_WIDTH = 1000;

/**
 * The width a proxied picture was asked for: TMDB's /t/p/w1920_and_h800...,
 * a cover's front-1200, or a picture of an artist. Null when it is unknown.
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
 * Whether the image proxy can convert a picture: its JPEGs and PNGs, album
 * covers (whose addresses have no file name), and pictures of artists.
 */
export const convertible = (url: string): boolean =>
  url.startsWith('/imageproxy/') &&
  (/\.(jpe?g|png)$/i.test(url) || /^\/imageproxy\/(caa|artist)\//.test(url));

/**
 * Where a TMDB picture is loaded from: through Seerr's image cache when it is
 * on, otherwise from TMDB itself.
 */
export const tmdbImageSrc = (src: string, cacheImages: boolean): string =>
  cacheImages && !src.startsWith('/')
    ? src.replace(/^https:\/\/image\.tmdb\.org\//, '/imageproxy/tmdb/')
    : src;

/**
 * The backdrop and poster at the top of a film's, series' or collection's
 * page. A card fetches them ahead (see preloadPicture) at these same
 * addresses, so the page finds them already there.
 */
export const titleBackdrop = (backdropPath: string) =>
  `https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${backdropPath}`;

export const titlePoster = (posterPath: string) =>
  `https://image.tmdb.org/t/p/w600_and_h900_bestv2${posterPath}`;

/**
 * The <source> list for a proxied picture: AVIF, then WebP, which the image
 * proxy converts to (and keeps), each in smaller widths too for a wide one.
 * Browsers take the first format they support and the width that suits the
 * screen; one that supports neither takes the <img> and its original.
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
 * How to fetch a picture ahead of the page that shows it: the attributes of
 * a <link rel="preload">. It names the best format only, with its type, so a
 * browser that cannot show that format fetches nothing rather than a copy it
 * would not use; and for a picture offered in several widths, the widths
 * themselves, so the browser picks the one its <picture> will (one that
 * cannot pick from them fetches nothing either).
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
 * Starts fetching a picture the next page shows at the top, while that page
 * is still on its way, so it is there (or nearly) when the page appears.
 * Only for a picture about to be shown: a page opened from a card.
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
  // Once fetched, the picture is the browser's (and the service worker's)
  // to keep; the link has done its job.
  const done = () => {
    link.remove();
    preloading.delete(key);
  };
  link.addEventListener('load', done);
  link.addEventListener('error', done);
  document.head.appendChild(link);
};
