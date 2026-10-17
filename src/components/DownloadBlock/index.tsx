import Badge from '@app/components/Common/Badge';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { secondsLeft } from '@app/utils/downloadSummary';
import { MediaType } from '@server/constants/media';
import type {
  DownloadStage,
  DownloadStep,
  DownloadingItem,
} from '@server/lib/downloadtracker';
import { FormattedRelativeTime, useIntl } from 'react-intl';

const messages = defineMessages('components.DownloadBlock', {
  estimatedtime: 'Estimated {time}',
  waiting: 'Waiting',
  waitingDetail:
    'Held by {arr}’s delay profile, in case a better release turns up',
  waitingFor:
    'Held by {arr}’s delay profile, in case a better release turns up; sent for download in {time}',
  hoursMinutes: '{hours} h {minutes} min',
  minutes: '{minutes} min',
  queued: 'Queued',
  paused: 'Paused',
  downloading: 'Downloading',
  stalled: 'Stalled',
  stalledDetail: 'Not downloading right now',
  finishing: 'Finishing up',
  finishingDetail: 'Downloaded; getting it ready to import',
  importing: 'Importing',
  importingDetail: 'Downloaded; being added to the library',
  needsAttention: 'Needs attention',
  needsAttentionDetail: 'Held up; an admin needs to look at it',
  failed: 'Failed',
  failedDetail: 'Download failed; looking for another',
  imported: 'Imported',
  importedDetail: 'In the library folder; showing up in a moment',
  stepVerifying: 'Downloaded; being verified',
  stepRepairing: 'Downloaded; being repaired',
  stepUnpacking: 'Downloaded; being unpacked',
  stepMoving: 'Downloaded; being moved into place',
  stepScript: 'Downloaded; running the post-processing script',
  stepChecked: 'Downloaded; being checked',
  stepChecking: 'Being checked before it starts',
  stepMetadata: 'Getting the torrent’s details',
  stepNoPeers: 'No one to download from right now',
  formattedTitle: '{title}: Season {seasonNumber} Episode {episodeNumber}',
  formattedSeason: '{title}: Season {seasonNumber}',
  formattedAlbum: '{album} — {title}',
});

/** How much has arrived, 0 to 100, whatever the server reported. */
const downloadedPercent = ({ size, sizeLeft }: DownloadingItem) => {
  if (!size || !Number.isFinite(size) || !Number.isFinite(sizeLeft)) {
    return 0;
  }
  return Math.min(
    100,
    Math.max(0, Math.round(((size - sizeLeft) / size) * 100))
  );
};

/** What the badge says, and a line under it after the download itself. */
const STAGES: Record<
  DownloadStage,
  {
    label: keyof typeof messages;
    detail?: keyof typeof messages;
    badge: 'default' | 'primary' | 'warning' | 'danger' | 'success';
  }
> = {
  waiting: { label: 'waiting', detail: 'waitingDetail', badge: 'default' },
  queued: { label: 'queued', badge: 'default' },
  paused: { label: 'paused', badge: 'default' },
  downloading: { label: 'downloading', badge: 'primary' },
  stalled: { label: 'stalled', detail: 'stalledDetail', badge: 'warning' },
  finishing: {
    label: 'finishing',
    detail: 'finishingDetail',
    badge: 'primary',
  },
  importing: {
    label: 'importing',
    detail: 'importingDetail',
    badge: 'success',
  },
  needsAttention: {
    label: 'needsAttention',
    detail: 'needsAttentionDetail',
    badge: 'warning',
  },
  failed: { label: 'failed', detail: 'failedDetail', badge: 'danger' },
  imported: { label: 'imported', detail: 'importedDetail', badge: 'success' },
};

/**
 * What the download client says it is doing, when Seerr reads it directly:
 * more exact than the stage's own line.
 */
const stepDetail = (
  stage: DownloadStage,
  step?: DownloadStep
): keyof typeof messages | undefined => {
  switch (step) {
    case 'verifying':
      return 'stepVerifying';
    case 'repairing':
      return 'stepRepairing';
    case 'unpacking':
      return 'stepUnpacking';
    case 'moving':
      return 'stepMoving';
    case 'script':
      return 'stepScript';
    case 'checking':
      return stage === 'finishing' ? 'stepChecked' : 'stepChecking';
    case 'metadata':
      return 'stepMetadata';
    case 'noPeers':
      return 'stepNoPeers';
    default:
      return undefined;
  }
};

interface DownloadBlockProps {
  downloadItem: DownloadingItem;
  is4k?: boolean;
  title?: string;
  /** It brings several episodes of its season, as a pack does. */
  pack?: boolean;
}

const DownloadBlock = ({
  downloadItem,
  is4k = false,
  title,
  pack = false,
}: DownloadBlockProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const percent = downloadedPercent(downloadItem);
  // A copy saved before stages were sent counts as downloading.
  const stage = STAGES[downloadItem.stage] ?? STAGES.downloading;
  const detail =
    stepDetail(downloadItem.stage, downloadItem.step) ?? stage.detail;
  const arr =
    downloadItem.mediaType === MediaType.MOVIE
      ? 'Radarr'
      : downloadItem.mediaType === MediaType.MUSIC
        ? 'Lidarr'
        : 'Sonarr';
  // Radarr and Sonarr hold a release for the delay its profile sets; what
  // they call time left is how long until they send it.
  const held =
    downloadItem.stage === 'waiting'
      ? secondsLeft(downloadItem.timeLeft)
      : undefined;
  const heldFor =
    held === undefined
      ? undefined
      : held >= 3600
        ? intl.formatMessage(messages.hoursMinutes, {
            hours: Math.floor(held / 3600),
            minutes: Math.floor((held % 3600) / 60),
          })
        : intl.formatMessage(messages.minutes, {
            minutes: Math.max(1, Math.round(held / 60)),
          });
  const estimate = downloadItem.estimatedCompletionTime
    ? new Date(downloadItem.estimatedCompletionTime)
    : undefined;

  return (
    <div className="p-4">
      <div className="mb-2 w-56 truncate text-sm sm:w-80 md:w-full">
        {hasPermission(Permission.ADMIN)
          ? downloadItem.title
          : downloadItem.episode && pack
            ? intl.formatMessage(messages.formattedSeason, {
                title,
                seasonNumber: downloadItem.episode.seasonNumber,
              })
            : downloadItem.episode
              ? intl.formatMessage(messages.formattedTitle, {
                  title,
                  seasonNumber: downloadItem?.episode?.seasonNumber,
                  episodeNumber: downloadItem?.episode?.episodeNumber,
                })
              : downloadItem.album?.title && title
                ? intl.formatMessage(messages.formattedAlbum, {
                    title,
                    album: downloadItem.album.title,
                  })
                : (downloadItem.album?.title ?? title)}
      </div>
      <div className="relative mb-2 h-6 min-w-0 overflow-hidden rounded-full bg-gray-700">
        <div
          className="h-8 bg-accent transition-all duration-200 ease-in-out"
          style={{ width: `${percent}%` }}
        />
        <div className="absolute inset-0 flex h-6 w-full items-center justify-center text-xs">
          <span>{percent}%</span>
        </div>
      </div>
      <div className="flex items-center justify-between text-xs">
        <span>
          {is4k && (
            <Badge badgeType="warning" className="mr-2">
              4K
            </Badge>
          )}
          <Badge badgeType={stage.badge}>
            {intl.formatMessage(messages[stage.label])}
          </Badge>
        </span>
        <span>
          {heldFor
            ? intl.formatMessage(messages.waitingFor, { arr, time: heldFor })
            : detail
              ? intl.formatMessage(messages[detail], { arr })
              : estimate && estimate.getTime() > Date.now()
                ? intl.formatMessage(messages.estimatedtime, {
                    time: (
                      <FormattedRelativeTime
                        value={Math.floor(
                          (estimate.getTime() - Date.now()) / 1000
                        )}
                        updateIntervalInSeconds={1}
                        numeric="auto"
                      />
                    ),
                  })
                : ''}
        </span>
      </div>
    </div>
  );
};

export default DownloadBlock;
