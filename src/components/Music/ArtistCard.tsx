import Button from '@app/components/Common/Button';
import MusicImage from '@app/components/Music/MusicImage';
import MusicStatusBadge from '@app/components/Music/MusicStatusBadge';
import {
  artistImageUrl,
  requestable,
} from '@app/components/Music/musicHelpers';
import RequestModal from '@app/components/RequestModal';
import CardShell, {
  NoPicture,
  cardImageSizes,
  useCardDetail,
} from '@app/components/TitleCard/CardShell';
import useFeature from '@app/hooks/useFeature';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import type { MediaStatus } from '@server/constants/media';
import { VARIOUS_ARTISTS_MBID } from '@server/constants/media';
import type { MusicArtistResult } from '@server/models/Music';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Music.ArtistCard', {
  artist: 'Artist',
});

interface ArtistCardProps {
  artist: MusicArtistResult;
  /** Fills a grid cell rather than taking a row's width. */
  canExpand?: boolean;
}

/**
 * An artist, as a film's or a series' card: their picture filling the
 * tile, and on hover or a tap their name and what sets them apart from
 * namesakes, with Request (which opens the choice of their albums) while
 * Seerr has none of them.
 */
const ArtistCard = ({ artist, canExpand }: ArtistCardProps) => {
  const intl = useIntl();
  const musicOn = useFeature('music');
  const { hasPermission } = useUser();
  const detail = useCardDetail();
  const [requesting, setRequesting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [missing, setMissing] = useState(false);
  // Shown at once after a request from the card, before the row reloads.
  const [requestedStatus, setRequestedStatus] = useState<MediaStatus>();
  const status = requestedStatus ?? artist.status;

  useEffect(() => {
    setMissing(false);
  }, [artist.id]);

  const canRequest =
    musicOn &&
    artist.id !== VARIOUS_ARTISTS_MBID &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_MUSIC], {
      type: 'or',
    });
  const showRequest = canRequest && requestable(status);

  return (
    <CardShell
      detail={detail}
      canExpand={canExpand}
      testId="artist-card"
      modals={
        canRequest && (
          <RequestModal
            type="music"
            show={requesting}
            artistMbid={artist.id}
            onUpdating={setUpdating}
            onCancel={() => setRequesting(false)}
            onComplete={(newStatus) => {
              setRequesting(false);
              setRequestedStatus(newStatus);
            }}
          />
        )
      }
      image={
        missing ? (
          <NoPicture />
        ) : (
          <MusicImage
            src={artistImageUrl(artist.id)}
            fallback="none"
            sizes={cardImageSizes(canExpand)}
            onMissing={() => setMissing(true)}
          />
        )
      }
      badge={{
        label: intl.formatMessage(messages.artist),
        className: 'border-teal-600 bg-teal-600/80',
      }}
      indicators={<MusicStatusBadge status={status} mini />}
      updating={updating}
      showOverlay={missing || detail.showDetail || requesting}
      href={`/music/artist/${artist.id}`}
      title={artist.name}
      summary={artist.disambiguation || artist.type}
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
            <span>{intl.formatMessage(globalMessages.request)}</span>
          </Button>
        )
      }
    />
  );
};

export default ArtistCard;
