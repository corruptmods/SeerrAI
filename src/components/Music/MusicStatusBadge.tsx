import Badge from '@app/components/Common/Badge';
import StatusBadgeMini from '@app/components/Common/StatusBadgeMini';
import StatusBadge from '@app/components/StatusBadge';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { MediaStatus, MediaType } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Music.MusicStatusBadge', {
  downloading: 'Downloading',
  adding: 'Adding to library',
});

interface MusicStatusBadgeProps {
  status?: MediaStatus;
  /** Lidarr downloads, each naming its album. */
  downloads?: DownloadingItem[];
  /** Lidarr has the files but no media server lists it yet. */
  addingToLibrary?: boolean;
  /** The managing artist's MusicBrainz id. */
  artistId?: string;
  /** Names the downloads in their details. */
  title?: string;
  serviceUrl?: string;
  /** Text only, no hover details or link: for a badge inside a link. */
  plain?: boolean;
  /** The round corner badge, as on film cards; spins while in progress. */
  mini?: boolean;
}

/** A pseudo-download for files Lidarr has but no media server lists yet. */
const beingAdded = (title?: string): DownloadingItem => ({
  mediaType: MediaType.MUSIC,
  externalId: 0,
  size: 1,
  sizeLeft: 0,
  status: '',
  stage: 'imported',
  timeLeft: '',
  title: title ?? '',
  downloadId: '',
});

/**
 * An album or artist's status badge; while downloading or being added to the
 * library, it shows progress as a film's does.
 */
const MusicStatusBadge = ({
  status,
  downloads = [],
  addingToLibrary = false,
  artistId,
  title,
  serviceUrl,
  plain = false,
  mini = false,
}: MusicStatusBadgeProps) => {
  const intl = useIntl();

  const onItsWay =
    (downloads.length > 0 || addingToLibrary) &&
    status !== undefined &&
    status !== MediaStatus.UNKNOWN &&
    status !== MediaStatus.PENDING &&
    status !== MediaStatus.BLOCKLISTED;

  if (mini) {
    return status !== undefined && status !== MediaStatus.UNKNOWN ? (
      <StatusBadgeMini status={status} inProgress={onItsWay} shrink />
    ) : null;
  }

  if (onItsWay && plain) {
    return (
      <Badge badgeType="primary">
        {intl.formatMessage(
          downloads.length ? messages.downloading : messages.adding
        )}
      </Badge>
    );
  }

  if (onItsWay) {
    return (
      <StatusBadge
        status={status}
        downloadItem={downloads.length ? downloads : [beingAdded(title)]}
        inProgress
        mediaType="music"
        artistId={artistId}
        serviceUrl={serviceUrl}
        title={title}
      />
    );
  }

  switch (status) {
    case MediaStatus.AVAILABLE:
      return (
        <Badge badgeType="success">
          {intl.formatMessage(globalMessages.available)}
        </Badge>
      );
    case MediaStatus.PARTIALLY_AVAILABLE:
      return (
        <Badge badgeType="success">
          {intl.formatMessage(globalMessages.partiallyavailable)}
        </Badge>
      );
    case MediaStatus.PROCESSING:
      return (
        <Badge badgeType="primary">
          {intl.formatMessage(globalMessages.requested)}
        </Badge>
      );
    case MediaStatus.PENDING:
      return (
        <Badge badgeType="warning">
          {intl.formatMessage(globalMessages.pending)}
        </Badge>
      );
    case MediaStatus.DELETED:
      return (
        <Badge badgeType="danger">
          {intl.formatMessage(globalMessages.deleted)}
        </Badge>
      );
    default:
      return null;
  }
};

export default MusicStatusBadge;
