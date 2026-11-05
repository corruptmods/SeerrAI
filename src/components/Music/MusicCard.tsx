import Button from '@app/components/Common/Button';
import MusicImage from '@app/components/Music/MusicImage';
import MusicStatusBadge from '@app/components/Music/MusicStatusBadge';
import {
  albumDownloads,
  albumKind,
  requestable,
  yearOf,
} from '@app/components/Music/musicHelpers';
import RequestModal from '@app/components/RequestModal';
import CardShell, {
  NoPicture,
  useCardDetail,
} from '@app/components/TitleCard/CardShell';
import Placeholder from '@app/components/TitleCard/Placeholder';
import useFeature from '@app/hooks/useFeature';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { MediaStatus, VARIOUS_ARTISTS_MBID } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import type { MusicAlbumResult } from '@server/models/Music';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Music.MusicCard', {
  album: 'Album',
  ep: 'EP',
  single: 'Single',
  release: 'Release',
  requestMore: 'Request More',
});

interface MusicCardProps {
  album: MusicAlbumResult;
  /** Fills a grid cell instead of a row's fixed width. */
  canExpand?: boolean;
  /**
   * The artist under the title; off on the artist's page, which shows the
   * album type instead.
   */
  showArtist?: boolean;
  /**
   * The artist to request under when the album lacks credits, as on an
   * artist's page.
   */
  artistId?: string;
  /** Called when the album is requested from the card. */
  onRequested?: () => void;
  /** The artist's Lidarr downloads; the card shows its album's. */
  downloads?: DownloadingItem[];
}

/**
 * A square cover in a 2:3 tile, over a blurred enlarged copy of itself. The
 * bands above and below hold the corner badges. One image, fetched once.
 */
export const CoverArt = ({
  src,
  onMissing,
}: {
  src: string;
  onMissing: () => void;
}) => (
  <>
    <div className="absolute inset-0 scale-150 blur-xl" aria-hidden="true">
      <MusicImage src={src} fallback="none" />
    </div>
    <div className="absolute inset-0 bg-media-scrim/40" />
    <div className="absolute inset-x-0 top-1/2 aspect-square -translate-y-1/2 shadow-lg">
      <MusicImage src={src} fallback="none" onMissing={onMissing} />
    </div>
  </>
);

/**
 * An album card: cover, release type and status, and on hover or tap its
 * year, title and artist, with Request when requestable.
 */
const MusicCard = ({
  album,
  canExpand,
  showArtist = true,
  artistId = album.artistId,
  onRequested,
  downloads,
}: MusicCardProps) => {
  const intl = useIntl();
  const musicOn = useFeature('music');
  const { hasPermission } = useUser();
  const detail = useCardDetail();
  const [requesting, setRequesting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [missing, setMissing] = useState(false);
  // Shown right after a request from the card, before the row reloads.
  const [requestedStatus, setRequestedStatus] = useState<MediaStatus>();
  const status = requestedStatus ?? album.status;

  useEffect(() => {
    setMissing(false);
  }, [album.coverUrl]);

  const canRequest =
    musicOn &&
    !!artistId &&
    artistId !== VARIOUS_ARTISTS_MBID &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_MUSIC], {
      type: 'or',
    });
  const showRequest = canRequest && requestable(status);

  return (
    <CardShell
      captioned
      detail={detail}
      canExpand={canExpand}
      testId="music-card"
      modals={
        canRequest &&
        artistId && (
          <RequestModal
            type="music"
            show={requesting}
            artistMbid={artistId}
            albumMbid={album.id}
            onUpdating={setUpdating}
            onCancel={() => setRequesting(false)}
            onComplete={(newStatus) => {
              setRequesting(false);
              setRequestedStatus(newStatus);
              onRequested?.();
            }}
          />
        )
      }
      image={
        missing ? (
          <NoPicture />
        ) : (
          <CoverArt src={album.coverUrl} onMissing={() => setMissing(true)} />
        )
      }
      badge={{
        label: intl.formatMessage(messages[albumKind(album)]),
        className: 'border-pink-600 bg-pink-600/fill light:bg-pink-700',
      }}
      indicators={
        <MusicStatusBadge
          status={status}
          downloads={albumDownloads(downloads, album.id)}
          addingToLibrary={album.addingToLibrary}
          mini
        />
      }
      updating={updating}
      showOverlay={missing || detail.showDetail || requesting}
      href={`/music/album/${album.id}`}
      overline={yearOf(album.releaseDate)}
      title={album.title}
      summary={showArtist ? album.artistName : album.secondaryTypes.join(' · ')}
      roomForActions={showRequest}
      actions={
        showRequest && (
          <Button
            buttonType="primary"
            buttonSize="sm"
            onClick={(e) => {
              e.preventDefault();
              setRequesting(true);
            }}
            className="h-7 w-full"
          >
            <ArrowDownTrayIcon />
            <span>
              {intl.formatMessage(
                // Partly here: request the rest.
                status === MediaStatus.PARTIALLY_AVAILABLE
                  ? messages.requestMore
                  : globalMessages.request
              )}
            </span>
          </Button>
        )
      }
    />
  );
};

/** Loading placeholder, as for films. */
MusicCard.Placeholder = Placeholder;

export default MusicCard;
