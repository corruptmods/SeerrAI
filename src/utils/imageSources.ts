import { IMAGE_FORMATS, IMAGE_WIDTHS } from '@server/constants/images';

/**
 * Backdrops and other pictures at least this wide are also offered in the
 * proxy's smaller widths, so a phone does not download a desktop backdrop.
 */
const RESPONSIVE_FROM = 1000;

/** The width TMDB was asked for in a /t/p/w1920_and_h800... address. */
const tmdbWidthOf = (url: string) => {
  const match = /\/t\/p\/w(\d+)/.exec(url);
  return match ? Number(match[1]) : null;
};

/**
 * The <source> list for a proxied picture: AVIF, then WebP, which the image
 * proxy converts to (and keeps), each in smaller widths too for a wide one.
 * Browsers take the first format they support and the width that suits the
 * screen; one that supports neither takes the <img> and its original.
 */
export const sourcesFor = (url: string) => {
  const width = tmdbWidthOf(url);
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
