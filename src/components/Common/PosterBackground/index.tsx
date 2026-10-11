import useSettings from '@app/hooks/useSettings';
import { IMAGE_FORMATS } from '@server/constants/images';
import { useEffect, useState } from 'react';

/**
 * Whether this browser takes image-set() with types, so a background can
 * offer the proxy's AVIF and WebP copies as <picture> does for an <img>.
 */
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
 * A poster drawn as a background image, served through Seerr's image proxy
 * when caching is on.
 *
 * If the proxied image fails — a bad cache entry, a proxy hiccup — it falls
 * back to fetching straight from TMDB rather than leaving a blank tile. A
 * background image raises no load event of its own, so the URL is probed with
 * an Image and the direct address substituted only if the proxy errors.
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
  // Decided after the first render, so it matches the server's.
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
    // The copy the background itself will use, so the probe is the same
    // download rather than a second one: every browser that takes typed
    // image-set() takes AVIF, the set's first choice.
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
