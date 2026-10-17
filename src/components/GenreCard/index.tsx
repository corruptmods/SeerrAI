import CachedImage from '@app/components/Common/CachedImage';
import { withProperties } from '@app/utils/typeHelpers';
import Link from 'next/link';
import { useState } from 'react';

interface GenreCardProps {
  name: string;
  image: string;
  url: string;
  canExpand?: boolean;
}

const GenreCard = ({ image, url, name, canExpand = false }: GenreCardProps) => {
  const [isHovered, setHovered] = useState(false);

  return (
    <Link
      href={url}
      className={`relative flex h-32 items-center justify-center sm:h-36 ${
        canExpand ? 'w-full' : 'w-56 sm:w-72'
      } transform-gpu cursor-pointer p-8 shadow ring-1 transition duration-300 ease-in-out ${
        // Dark behind the white name in every look, before the picture
        // arrives and around it.
        isHovered
          ? 'scale-105 bg-gray-700/100 ring-gray-500 light:bg-[rgb(var(--media-scrim-raised))]'
          : 'scale-100 bg-[rgb(var(--media-scrim-raised)/0.8)] ring-subtle'
      } overflow-hidden rounded-xl bg-cover bg-center`}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          setHovered(true);
        }
      }}
      role="link"
      tabIndex={0}
    >
      <CachedImage
        type="tmdb"
        src={image}
        alt=""
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        fill
      />
      <div
        className={`absolute inset-0 z-10 h-full w-full transition duration-300 ${
          isHovered
            ? 'bg-[rgb(var(--media-scrim-raised)/0.1)]'
            : 'bg-[rgb(var(--media-scrim-raised)/0.3)]'
        }`}
      />
      <div className="relative z-20 w-full truncate whitespace-normal text-center text-2xl font-bold text-on-media sm:text-3xl">
        {name}
      </div>
    </Link>
  );
};

const GenreCardPlaceholder = () => {
  return (
    <div
      className={`relative h-32 w-56 animate-pulse rounded-xl bg-gray-700 sm:h-40 sm:w-72`}
    />
  );
};

export default withProperties(GenreCard, { Placeholder: GenreCardPlaceholder });
