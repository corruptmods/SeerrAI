import { musicImageSrc } from '@app/components/Music/musicHelpers';
import { NearScreen } from '@app/hooks/useNearScreen';
import useSettings from '@app/hooks/useSettings';
import { convertible, sourcesFor, tmdbImageSrc } from '@app/utils/imageSources';
import { pictureLoading } from '@app/utils/nearScreen';
import type { ImageLoader, ImageProps } from 'next/image';
import Image from 'next/image';
import { useContext } from 'react';

const imageLoader: ImageLoader = ({ src }) => src;

export type CachedImageProps = ImageProps & {
  src: string;
  /**
   * Where the picture comes from. 'music' is an album cover (Cover Art
   * Archive), a picture from fanart.tv or TheAudioDB, or the server's
   * address for a picture of an artist.
   */
  type: 'tmdb' | 'avatar' | 'tvdb' | 'music';
};

/**
 * The CachedImage component should be used wherever
 * we want to offer the option to locally cache images.
 **/
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
    // jellyfin avatar (if any)
    imageUrl = src;
  } else {
    return null;
  }

  // Inside a card or row near the screen, the picture loads before it is
  // scrolled to (see nearScreen).
  const loading = pictureLoading(nearness, { loading: props.loading });

  // Only what the proxy can convert.
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

  // Next would preload the <img>'s own address for a priority image, which
  // a browser using a <source> never shows: it would be downloaded twice.
  // Fetching it eagerly and first does the same job without that.
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
