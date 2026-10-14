import CachedImage from '@app/components/Common/CachedImage';
import { MusicalNoteIcon, UserIcon } from '@heroicons/react/24/outline';
import { useEffect, useState } from 'react';

interface MusicImageProps {
  /** A cover, a picture of an artist, or none. */
  src?: string;
  /** What stands in for a picture that is not there: an icon, or nothing. */
  fallback: 'album' | 'artist' | 'none';
  priority?: boolean;
  sizes?: string;
  className?: string;
  /** Told when there turns out to be no picture. */
  onMissing?: () => void;
}

/**
 * An album cover or a picture of an artist, filling its box (which must be
 * positioned). Cached and converted as posters are. Many albums have no
 * cover and many artists no picture: the archive answers 404, and a plain
 * icon takes its place.
 */
const MusicImage = ({
  src,
  fallback,
  priority,
  sizes,
  className,
  onMissing,
}: MusicImageProps) => {
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
    <CachedImage
      type="music"
      src={src}
      alt=""
      fill
      sizes={sizes}
      className={className}
      style={{ objectFit: 'cover' }}
      onError={() => {
        setFailed(true);
        onMissing?.();
      }}
      {...(priority ? { priority: true } : { loading: 'lazy' })}
    />
  );
};

export default MusicImage;
