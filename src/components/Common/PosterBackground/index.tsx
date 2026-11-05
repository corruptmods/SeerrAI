import useSettings from '@app/hooks/useSettings';
import { IMAGE_FORMATS } from '@server/constants/images';
import { useEffect, useState } from 'react';

/** Whether image-set() takes types, so a background can offer AVIF and WebP. */
const supportsTypedImageSet = () =>
  typeof CSS !== 'undefined' &&
  CSS.supports(
    'background-image',
    'image-set(url("x.avif") type("image/avif"), url("x.jpg") type("image/jpeg"))'
  );

/** The background for a proxied poster: AVIF, WebP, then the original. */
const imageSetFor = (url: string) =>
  `image-set(${[
    ...IMAGE_FORMATS.map(
      (format) => `url("${url}?f=${format}") type("image/${format}")`
    ),
    `url("${url}") type("image/jpeg")`,
  ].join(', ')})`;

interface PosterBackgroundProps {
  posterPath?: string | null;
  /** TMDB size segment, e.g. w500. */
  size?: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * A poster as a background image, through Seerr's image proxy when caching
 * is on.
 *
 * Falls back to TMDB directly if the proxied image fails. A background image
 * has no load event, so the URL is probed with an Image.
 */
const PosterBackground = ({
  posterPath,
  size = 'w500',
  className,
  style,
}: PosterBackgroundProps) => {
  const settings = useSettings();
  const direct = posterPath
    ? `https://image.tmdb.org/t/p/${size}${posterPath}`
    : '';
  const proxied =
    posterPath && settings.currentSettings.cacheImages
      ? `/imageproxy/tmdb/t/p/${size}${posterPath}`
      : direct;

  const [src, setSrc] = useState(proxied);
  // Set after the first render, to match the server render.
  const [typedImageSet, setTypedImageSet] = useState(false);

  useEffect(() => {
    setTypedImageSet(supportsTypedImageSet());
  }, []);

  useEffect(() => {
    setSrc(proxied);

    if (!posterPath || proxied === direct) {
      return;
    }

    let cancelled = false;
    const probe = new window.Image();

    probe.onerror = () => {
      if (!cancelled) {
        setSrc(direct);
      }
    };
    // Probe the copy the background will use, so it is one download: every
    // browser with typed image-set() takes AVIF, the set's first choice.
    probe.src = supportsTypedImageSet()
      ? `${proxied}?f=${IMAGE_FORMATS[0]}`
      : proxied;

    return () => {
      cancelled = true;
      probe.onerror = null;
    };
  }, [proxied, direct, posterPath]);

  return (
    <div
      className={className}
      style={{
        ...style,
        ...(src
          ? {
              backgroundImage:
                typedImageSet && src.startsWith('/imageproxy/')
                  ? imageSetFor(src)
                  : `url(${src})`,
            }
          : {}),
      }}
    />
  );
};

export default PosterBackground;
