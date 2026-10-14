import MusicImage from '@app/components/Music/MusicImage';
import MusicStatusBadge from '@app/components/Music/MusicStatusBadge';
import { requestable, yearOf } from '@app/components/Music/musicHelpers';
import RequestModal from '@app/components/RequestModal';
import useFeature from '@app/hooks/useFeature';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import type { MediaStatus } from '@server/constants/media';
import { VARIOUS_ARTISTS_MBID } from '@server/constants/media';
import type { MusicAlbumResult } from '@server/models/Music';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Music.MusicCard', {
  requestAlbum: 'Request {title}',
});

interface MusicCardProps {
  album: MusicAlbumResult;
  /** Fills a grid cell rather than taking a row's width. */
  canExpand?: boolean;
  /** Under the title: the artist (rows, search), or the year (their page). */
  subtitle?: 'artist' | 'year';
  /**
   * The artist the album is requested under, where the album does not say
   * (an artist's own page lists their albums without their credits).
   */
  artistId?: string;
  /** Told when the album has been requested from the card. */
  onRequested?: () => void;
}

const width = (canExpand?: boolean) =>
  canExpand ? 'w-full' : 'w-36 sm:w-36 md:w-44';

/** An album: its cover, title and artist or year, and whether it is here. */
const MusicCard = ({
  album,
  canExpand,
  subtitle = 'artist',
  artistId = album.artistId,
  onRequested,
}: MusicCardProps) => {
  const intl = useIntl();
  const musicOn = useFeature('music');
  const { hasPermission } = useUser();
  const [requesting, setRequesting] = useState(false);
  // Shown at once after a request from the card, before the row reloads.
  const [requestedStatus, setRequestedStatus] = useState<MediaStatus>();
  const status = requestedStatus ?? album.status;
  const year = yearOf(album.releaseDate);
  const below =
    subtitle === 'artist' ? (album.artistName ?? year) : (year ?? '—');

  const card = (
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
            <MusicStatusBadge status={status} />
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

  const canRequest =
    musicOn &&
    !!artistId &&
    artistId !== VARIOUS_ARTISTS_MBID &&
    requestable(status) &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_MUSIC], {
      type: 'or',
    });

  if (!canRequest) {
    return card;
  }

  // Beside the link rather than in it: a button inside a link is neither
  // one thing nor the other to a keyboard or a screen reader.
  return (
    <div className={`relative ${width(canExpand)}`}>
      {card}
      <button
        type="button"
        className="absolute left-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600 text-white shadow ring-1 ring-indigo-400 transition hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        aria-label={intl.formatMessage(messages.requestAlbum, {
          title: album.title,
        })}
        title={intl.formatMessage(messages.requestAlbum, {
          title: album.title,
        })}
        onClick={() => setRequesting(true)}
      >
        <ArrowDownTrayIcon className="h-4 w-4" />
      </button>
      {requesting && (
        <RequestModal
          type="music"
          show
          artistMbid={artistId}
          albumMbid={album.id}
          onCancel={() => setRequesting(false)}
          onComplete={(newStatus) => {
            setRequesting(false);
            setRequestedStatus(newStatus);
            onRequested?.();
          }}
        />
      )}
    </div>
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
