import { musicImageSrc } from '@app/components/Music/musicHelpers';
import useSettings from '@app/hooks/useSettings';
import { MusicalNoteIcon, UserIcon } from '@heroicons/react/24/outline';
import type { ImageLoader } from 'next/image';
import Image from 'next/image';
import { useEffect, useState } from 'react';

const imageLoader: ImageLoader = ({ src }) => src;

interface MusicImageProps {
  /** A cover, a picture of an artist, or none. */
  src?: string;
  /** What stands in for a picture that is not there: an icon, or nothing. */
  fallback: 'album' | 'artist' | 'none';
  priority?: boolean;
  sizes?: string;
}

/**
 * An album cover or a picture of an artist, filling its box (which must be
 * positioned). Many albums have no cover and many artists no picture: the
 * archive answers 404, and a plain icon takes its place.
 */
const MusicImage = ({ src, fallback, priority, sizes }: MusicImageProps) => {
  const { currentSettings } = useSettings();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    if (fallback === 'none') {
      return null;
    }
    const Icon = fallback === 'artist' ? UserIcon : MusicalNoteIcon;
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-gray-700 text-gray-500">
        <Icon className="h-1/3 w-1/3" />
      </div>
    );
  }

  return (
    <Image
      unoptimized
      loader={imageLoader}
      src={musicImageSrc(src, currentSettings.cacheImages)}
      alt=""
      fill
      sizes={sizes}
      style={{ objectFit: 'cover' }}
      onError={() => setFailed(true)}
      {...(priority
        ? { loading: 'eager', fetchPriority: 'high' }
        : { loading: 'lazy' })}
    />
  );
};

export default MusicImage;
