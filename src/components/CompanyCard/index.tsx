import CachedImage from '@app/components/Common/CachedImage';
import Link from 'next/link';
import { useState } from 'react';

interface CompanyCardProps {
  name: string;
  image: string;
  url: string;
}

const CompanyCard = ({ image, url, name }: CompanyCardProps) => {
  const [isHovered, setHovered] = useState(false);

  return (
    <Link
      href={url}
      className={`relative flex h-32 w-56 transform-gpu cursor-pointer items-center justify-center p-8 shadow ring-1 transition duration-300 ease-in-out sm:h-36 sm:w-72 ${
        isHovered
          ? 'scale-105 bg-gray-700 ring-gray-500'
          : 'scale-100 bg-surface ring-subtle'
      } rounded-xl`}
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
      <div className="relative h-full w-full">
        <CachedImage
          type="tmdb"
          src={image}
          alt={name}
          // Studio and network logos come white, for a dark card; in light
          // mode they are turned dark, for a light one.
          className="relative z-40 h-full w-full light:invert"
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          fill
        />
      </div>
      <div
        className={`absolute bottom-0 left-0 right-0 z-0 h-12 rounded-b-xl bg-gradient-to-t ${
          isHovered ? 'from-surface' : 'from-page'
        }`}
      />
    </Link>
  );
};

export default CompanyCard;
