import MusicImage from '@app/components/Music/MusicImage';
import MusicStatusBadge from '@app/components/Music/MusicStatusBadge';
import { yearOf } from '@app/components/Music/musicHelpers';
import type { MusicAlbumResult } from '@server/models/Music';
import Link from 'next/link';

interface MusicCardProps {
  album: MusicAlbumResult;
  /** Fills a grid cell rather than taking a row's width. */
  canExpand?: boolean;
  /** Under the title: the artist (rows, search), or the year (their page). */
  subtitle?: 'artist' | 'year';
}

const width = (canExpand?: boolean) =>
  canExpand ? 'w-full' : 'w-36 sm:w-36 md:w-44';

/** An album: its cover, title and artist or year, and whether it is here. */
const MusicCard = ({
  album,
  canExpand,
  subtitle = 'artist',
}: MusicCardProps) => {
  const year = yearOf(album.releaseDate);
  const below =
    subtitle === 'artist' ? (album.artistName ?? year) : (year ?? '—');

  return (
    <Link
      href={`/music/album/${album.id}`}
      className={`group block ${width(canExpand)}`}
      data-testid="music-card"
    >
      <div className="overflow-hidden rounded-xl bg-gray-800 shadow ring-1 ring-gray-700 transition duration-150 group-hover:ring-gray-500 group-focus-visible:ring-indigo-500">
        <div className="relative w-full" style={{ paddingBottom: '100%' }}>
          <MusicImage
            src={album.coverUrl}
            fallback="album"
            sizes="(min-width: 768px) 11rem, 9rem"
          />
          <div className="absolute right-2 top-2">
            <MusicStatusBadge status={album.status} />
          </div>
        </div>
        <div className="px-2 py-2">
          <div className="truncate text-sm font-semibold text-white">
            {album.title}
          </div>
          <div className="truncate text-xs text-gray-400">{below}</div>
        </div>
      </div>
    </Link>
  );
};

/** Where a card will be while its row loads. */
const Placeholder = ({ canExpand }: { canExpand?: boolean }) => (
  <div
    className={`animate-pulse overflow-hidden rounded-xl bg-gray-700 ${width(
      canExpand
    )}`}
  >
    <div className="w-full" style={{ paddingBottom: '135%' }} />
  </div>
);

MusicCard.Placeholder = Placeholder;

export default MusicCard;
