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
