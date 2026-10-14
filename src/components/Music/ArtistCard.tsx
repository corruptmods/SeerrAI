import MusicImage from '@app/components/Music/MusicImage';
import MusicStatusBadge from '@app/components/Music/MusicStatusBadge';
import { artistImageUrl } from '@app/components/Music/musicHelpers';
import type { MusicArtistResult } from '@server/models/Music';
import Link from 'next/link';

interface ArtistCardProps {
  artist: MusicArtistResult;
  /** Fills a grid cell rather than taking a row's width. */
  canExpand?: boolean;
}

/** An artist: their picture, name, and what sets them apart from namesakes. */
const ArtistCard = ({ artist, canExpand }: ArtistCardProps) => (
  <Link
    href={`/music/artist/${artist.id}`}
    className={`group block ${canExpand ? 'w-full' : 'w-36 sm:w-36 md:w-44'}`}
    data-testid="artist-card"
  >
    <div className="overflow-hidden rounded-xl bg-gray-800 p-3 shadow ring-1 ring-gray-700 transition duration-150 group-hover:ring-gray-500 group-focus-visible:ring-indigo-500">
      <div
        className="relative w-full overflow-hidden rounded-full ring-1 ring-gray-700"
        style={{ paddingBottom: '100%' }}
      >
        <MusicImage
          src={artistImageUrl(artist.id)}
          fallback="artist"
          sizes="(min-width: 768px) 10rem, 8rem"
        />
      </div>
      <div className="mt-2 truncate text-center text-sm font-semibold text-white">
        {artist.name}
      </div>
      <div className="truncate text-center text-xs text-gray-400">
        {artist.disambiguation || artist.type || ' '}
      </div>
      {artist.status && (
        <div className="mt-1 flex justify-center">
          <MusicStatusBadge status={artist.status} />
        </div>
      )}
    </div>
  </Link>
);

export default ArtistCard;
