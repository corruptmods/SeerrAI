import { musicImageSrc } from '@app/components/Music/musicHelpers';
import { NearScreen } from '@app/hooks/useNearScreen';
import useSettings from '@app/hooks/useSettings';
import { convertible, sourcesFor, tmdbImageSrc } from '@app/utils/imageSources';
import { pictureLoading } from '@app/utils/nearScreen';
import type { ImageLoader, ImageProps } from 'next/image';
import Image from 'next/image';
import { useContext } from 'react';

const imageLoader: ImageLoader = ({ src }) => src;

const PLEX_AVATAR =
  /^https:\/\/plex\.tv\/users\/([0-9a-f]{8,64})\/avatar(?:\?c=([0-9]+))?/;

/**
 * A Plex avatar served through Seerr AI's cache, as plex.tv doesn't always
 * answer. The version number is kept, so a changed picture is refetched.
 * Jellyfin and Emby avatars already go through it.
 */
export const avatarSrc = (src: string): string => {
  const plex = PLEX_AVATAR.exec(src);
  return plex
    ? `/avatarproxy/plex/${plex[1]}${plex[2] ? `?c=${plex[2]}` : ''}`
    : src;
};

export type CachedImageProps = ImageProps & {
  src: string;
  /**
   * 'music': a Cover Art Archive cover, a fanart.tv or TheAudioDB picture,
   * or the server's artist-picture address.
   */
  type: 'tmdb' | 'avatar' | 'tvdb' | 'music';
};

/** An image served through the local image cache when caching is on. */
const CachedImage = ({ src, type, ...props }: CachedImageProps) => {
  const { currentSettings } = useSettings();
  const nearness = useContext(NearScreen);

  let imageUrl: string;

  if (type === 'tmdb') {
    imageUrl = tmdbImageSrc(src, currentSettings.cacheImages);
  } else if (type === 'tvdb') {
    imageUrl =
      currentSettings.cacheImages && !src.startsWith('/')
        ? src.replace(
            /^https:\/\/artworks\.thetvdb\.com\//,
            '/imageproxy/tvdb/'
          )
        : src;
  } else if (type === 'music') {
    imageUrl = musicImageSrc(src, currentSettings.cacheImages);
  } else if (type === 'avatar') {
    imageUrl = avatarSrc(src);
  } else {
    return null;
  }

  // Loads early inside a card or row near the screen (see nearScreen).
  const loading = pictureLoading(nearness, { loading: props.loading });

  // The proxy can't convert it: no <picture> sources.
  if (!convertible(imageUrl)) {
    return (
      <Image
        unoptimized
        loader={imageLoader}
        src={imageUrl}
        {...props}
        {...(props.priority || props.preload ? {} : loading)}
      />
    );
  }

  // Next would preload a priority image's <img> address, which a browser
  // using a <source> never shows, so it would download twice. Eager, high
  // priority loading does the same job.
  const { priority, preload, sizes, ...imageProps } = props;
  const urgent = !!(priority || preload);

  return (
    // display: contents keeps the <img> laid out as it would be on its own.
    <picture style={{ display: 'contents' }}>
      {sourcesFor(imageUrl).map((source) => (
        <source
          key={source.type}
          type={source.type}
          srcSet={source.srcSet}
          sizes={source.responsive ? (sizes ?? '100vw') : undefined}
        />
      ))}
      <Image
        unoptimized
        loader={imageLoader}
        src={imageUrl}
        sizes={sizes}
        {...imageProps}
        {...(urgent ? pictureLoading(null, { urgent }) : loading)}
      />
    </picture>
  );
};

export default CachedImage;
