import useSettings from '@app/hooks/useSettings';
import { sourcesFor } from '@app/utils/imageSources';
import type { ImageLoader, ImageProps } from 'next/image';
import Image from 'next/image';

const imageLoader: ImageLoader = ({ src }) => src;

export type CachedImageProps = ImageProps & {
  src: string;
  type: 'tmdb' | 'avatar' | 'tvdb';
};

/**
 * The CachedImage component should be used wherever
 * we want to offer the option to locally cache images.
 **/
const CachedImage = ({ src, type, ...props }: CachedImageProps) => {
  const { currentSettings } = useSettings();

  let imageUrl: string;

  if (type === 'tmdb') {
    // tmdb stuff
    imageUrl =
      currentSettings.cacheImages && !src.startsWith('/')
        ? src.replace(/^https:\/\/image\.tmdb\.org\//, '/imageproxy/tmdb/')
        : src;
  } else if (type === 'tvdb') {
    imageUrl =
      currentSettings.cacheImages && !src.startsWith('/')
        ? src.replace(
            /^https:\/\/artworks\.thetvdb\.com\//,
            '/imageproxy/tvdb/'
          )
        : src;
  } else if (type === 'avatar') {
    // jellyfin avatar (if any)
    imageUrl = src;
  } else {
    return null;
  }

  // Only what the proxy can convert: its JPEG and PNG pictures.
  if (
    !imageUrl.startsWith('/imageproxy/') ||
    !/\.(jpe?g|png)$/i.test(imageUrl)
  ) {
    return <Image unoptimized loader={imageLoader} src={imageUrl} {...props} />;
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
        {...(urgent ? { loading: 'eager', fetchPriority: 'high' } : {})}
      />
    </picture>
  );
};

export default CachedImage;
