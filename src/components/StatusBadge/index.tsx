import Spinner from '@app/assets/spinner.svg';
import Badge from '@app/components/Common/Badge';
import Tooltip from '@app/components/Common/Tooltip';
import DownloadBlock from '@app/components/DownloadBlock';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  downloadBadgeLabel,
  episodeSpan,
  isDownloadBusy,
  isOneRelease,
  summarizeDownloads,
} from '@app/utils/downloadSummary';
import { MediaStatus } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.StatusBadge', {
  status: '{status}',
  status4k: '4K {status}',
  playonplex: 'Play on {mediaServerName}',
  openinarr: 'Open in {arr}',
  managemedia: 'Manage {mediaType}',
  seasonnumber: 'S{seasonNumber}',
  seasonepisodenumber: 'S{seasonNumber}E{episodeNumber}',
  episoderange: 'S{seasonNumber}E{first}–E{last}',
  seasonrange: 'S{first}–S{last}',
  downloading: 'Downloading',
  downloadingPercent: 'Downloading {percent}%',
  stalled: 'Stalled',
  gettingDetails: 'Getting details',
  checking: 'Checking',
  queued: 'Queued',
  paused: 'Paused',
  waiting: 'Waiting',
  verifying: 'Verifying',
  repairing: 'Repairing',
  unpacking: 'Unpacking',
  moving: 'Moving',
  runningScript: 'Running script',
  finishing: 'Finishing up',
  importing: 'Importing',
  needsAttention: 'Needs attention',
  failed: 'Download failed',
  imported: 'Adding to {mediaServerName}',
});

interface StatusBadgeProps {
  status?: MediaStatus;
  downloadItem?: DownloadingItem[];
  is4k?: boolean;
  inProgress?: boolean;
  plexUrl?: string;
  serviceUrl?: string;
  tmdbId?: number;
  mediaType?: 'movie' | 'tv';
  title?: string | string[];
  statusLabelOverride?: string;
}

const StatusBadge = ({
  status,
  downloadItem = [],
  is4k = false,
  inProgress = false,
  plexUrl,
  serviceUrl,
  tmdbId,
  mediaType,
  title,
  statusLabelOverride,
}: StatusBadgeProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const settings = useSettings();

  let mediaLink: string | undefined;
  let mediaLinkDescription: string | undefined;

  const mediaServerName =
    settings.currentSettings.mediaServerType === MediaServerType.EMBY
      ? 'Emby'
      : settings.currentSettings.mediaServerType === MediaServerType.PLEX
        ? 'Plex'
        : 'Jellyfin';

  // What is actually happening to its downloads, all of them together.
  const download = summarizeDownloads(downloadItem);
  const downloadBusy = !download || isDownloadBusy(download);
  const downloadLabel = (() => {
    if (!download) {
      return intl.formatMessage(globalMessages.processing);
    }
    const label = downloadBadgeLabel(download);
    return label === 'downloading' && download.percent !== undefined
      ? intl.formatMessage(messages.downloadingPercent, {
          percent: download.percent,
        })
      : intl.formatMessage(messages[label], { mediaServerName });
  })();

  // Which episodes are downloading: a season pack names its season, not
  // whichever of its episodes is listed first.
  const span = mediaType === 'tv' ? episodeSpan(downloadItem) : undefined;
  const episodeLabel = !span
    ? undefined
    : span.kind === 'episode'
      ? intl.formatMessage(messages.seasonepisodenumber, {
          seasonNumber: span.season,
          episodeNumber: span.episode,
        })
      : span.kind === 'season'
        ? intl.formatMessage(messages.seasonnumber, {
            seasonNumber: span.season,
          })
        : span.kind === 'episodes'
          ? intl.formatMessage(messages.episoderange, {
              seasonNumber: span.season,
              first: span.first,
              last: span.last,
            })
          : intl.formatMessage(messages.seasonrange, {
              first: span.first,
              last: span.last,
            });

  if (
    mediaType &&
    plexUrl &&
    hasPermission(
      is4k
        ? [
            Permission.REQUEST_4K,
            mediaType === 'movie'
              ? Permission.REQUEST_4K_MOVIE
              : Permission.REQUEST_4K_TV,
          ]
        : [
            Permission.REQUEST,
            mediaType === 'movie'
              ? Permission.REQUEST_MOVIE
              : Permission.REQUEST_TV,
          ],
      {
        type: 'or',
      }
    ) &&
    (!is4k ||
      (mediaType === 'movie'
        ? settings.currentSettings.movie4kEnabled
        : settings.currentSettings.series4kEnabled))
  ) {
    mediaLink = plexUrl;
    mediaLinkDescription = intl.formatMessage(messages.playonplex, {
      mediaServerName,
    });
  } else if (hasPermission(Permission.MANAGE_REQUESTS)) {
    if (mediaType && tmdbId) {
      mediaLink = `/${mediaType}/${tmdbId}?manage=1`;
      mediaLinkDescription = intl.formatMessage(messages.managemedia, {
        mediaType: intl.formatMessage(
          mediaType === 'movie' ? globalMessages.movie : globalMessages.tvshow
        ),
      });
    } else if (hasPermission(Permission.ADMIN) && serviceUrl) {
      mediaLink = serviceUrl;
      mediaLinkDescription = intl.formatMessage(messages.openinarr, {
        arr: mediaType === 'movie' ? 'Radarr' : 'Sonarr',
      });
    }
  }

  const tooltipContent =
    mediaType === 'tv' &&
    downloadItem.length > 1 &&
    isOneRelease(downloadItem) ? (
      <DownloadBlock
        downloadItem={downloadItem[0]}
        title={Array.isArray(title) ? title[0] : title}
        is4k={is4k}
        pack
      />
    ) : (
      <ul>
        {downloadItem.map((status, index) => (
          <li
            key={`dl-status-${status.externalId}-${index}`}
            className="border-b border-gray-700 last:border-b-0"
          >
            <DownloadBlock
              downloadItem={status}
              title={Array.isArray(title) ? title[index] : title}
              is4k={is4k}
            />
          </li>
        ))}
      </ul>
    );

  const badgeDownloadProgress = (
    <div
      className={`absolute left-0 top-0 z-10 flex h-full ${
        status === MediaStatus.DELETED
          ? 'bg-red-600/80'
          : status === MediaStatus.PROCESSING
            ? 'bg-indigo-500/80'
            : 'bg-green-500/80'
      } transition-all duration-200 ease-in-out`}
      style={{
        width: `${download?.percent ?? 0}%`,
      }}
    />
  );

  switch (status) {
    case MediaStatus.AVAILABLE:
      return (
        <Tooltip
          content={inProgress ? tooltipContent : mediaLinkDescription}
          className={`${
            inProgress && 'hidden max-h-96 w-96 overflow-y-auto sm:block'
          }`}
          tooltipConfig={{
            ...(inProgress && { interactive: true, delayHide: 100 }),
          }}
        >
          <Badge
            badgeType="success"
            href={mediaLink}
            className={`${
              inProgress && 'relative !bg-gray-700/80 !px-0 hover:!bg-gray-700'
            } overflow-hidden`}
          >
            {inProgress && badgeDownloadProgress}
            <div
              className={`relative z-20 flex items-center ${
                inProgress && 'px-2'
              }`}
            >
              <span>
                {intl.formatMessage(
                  is4k ? messages.status4k : messages.status,
                  {
                    status: inProgress
                      ? downloadLabel
                      : intl.formatMessage(globalMessages.available),
                  }
                )}
              </span>
              {inProgress && (
                <>
                  {episodeLabel && <span className="ml-1">{episodeLabel}</span>}
                  {downloadBusy && <Spinner className="ml-1 h-3 w-3" />}
                </>
              )}
            </div>
          </Badge>
        </Tooltip>
      );

    case MediaStatus.PARTIALLY_AVAILABLE:
      return (
        <Tooltip
          content={inProgress ? tooltipContent : mediaLinkDescription}
          className={`${
            inProgress && 'hidden max-h-96 w-96 overflow-y-auto sm:block'
          }`}
          tooltipConfig={{
            ...(inProgress && { interactive: true, delayHide: 100 }),
          }}
        >
          <Badge
            badgeType="success"
            href={mediaLink}
            className={`${
              inProgress && 'relative !bg-gray-700/80 !px-0 hover:!bg-gray-700'
            } overflow-hidden`}
          >
            {inProgress && badgeDownloadProgress}
            <div
              className={`relative z-20 flex items-center ${
                inProgress && 'px-2'
              }`}
            >
              <span>
                {intl.formatMessage(
                  is4k ? messages.status4k : messages.status,
                  {
                    status: inProgress
                      ? downloadLabel
                      : intl.formatMessage(globalMessages.partiallyavailable),
                  }
                )}
              </span>
              {inProgress && (
                <>
                  {episodeLabel && <span className="ml-1">{episodeLabel}</span>}
                  {downloadBusy && <Spinner className="ml-1 h-3 w-3" />}
                </>
              )}
            </div>
          </Badge>
        </Tooltip>
      );

    case MediaStatus.PROCESSING:
      return (
        <Tooltip
          content={inProgress ? tooltipContent : mediaLinkDescription}
          className={`${
            inProgress && 'hidden max-h-96 w-96 overflow-y-auto sm:block'
          }`}
          tooltipConfig={{
            ...(inProgress && { interactive: true, delayHide: 100 }),
          }}
        >
          <Badge
            badgeType="primary"
            href={mediaLink}
            className={`${
              inProgress && 'relative !bg-gray-700/80 !px-0 hover:!bg-gray-700'
            } overflow-hidden`}
          >
            {inProgress && badgeDownloadProgress}
            <div
              className={`relative z-20 flex items-center ${
                inProgress && 'px-2'
              }`}
            >
              <span>
                {intl.formatMessage(
                  is4k ? messages.status4k : messages.status,
                  {
                    status: inProgress
                      ? downloadLabel
                      : intl.formatMessage(globalMessages.requested),
                  }
                )}
              </span>
              {inProgress && (
                <>
                  {episodeLabel && <span className="ml-1">{episodeLabel}</span>}
                  {downloadBusy && <Spinner className="ml-1 h-3 w-3" />}
                </>
              )}
            </div>
          </Badge>
        </Tooltip>
      );

    case MediaStatus.PENDING:
      return (
        <Tooltip content={mediaLinkDescription}>
          <Badge badgeType="warning" href={mediaLink}>
            {intl.formatMessage(is4k ? messages.status4k : messages.status, {
              status: intl.formatMessage(globalMessages.pending),
            })}
          </Badge>
        </Tooltip>
      );

    case MediaStatus.BLOCKLISTED:
      return (
        <Tooltip content={mediaLinkDescription}>
          <Badge badgeType="danger" href={mediaLink}>
            {intl.formatMessage(is4k ? messages.status4k : messages.status, {
              status:
                statusLabelOverride ??
                intl.formatMessage(globalMessages.blocklisted),
            })}
          </Badge>
        </Tooltip>
      );

    case MediaStatus.DELETED:
      return (
        <Tooltip
          content={inProgress ? tooltipContent : mediaLinkDescription}
          className={`${
            inProgress && 'hidden max-h-96 w-96 overflow-y-auto sm:block'
          }`}
          tooltipConfig={{
            ...(inProgress && { interactive: true, delayHide: 100 }),
          }}
        >
          <Badge
            badgeType="danger"
            href={mediaLink}
            className={`${
              inProgress && 'relative !bg-gray-700/80 !px-0 hover:!bg-gray-700'
            } overflow-hidden`}
          >
            {inProgress && badgeDownloadProgress}
            <div
              className={`relative z-20 flex items-center ${
                inProgress && 'px-2'
              }`}
            >
              <span>
                {intl.formatMessage(
                  is4k ? messages.status4k : messages.status,
                  {
                    status: inProgress
                      ? downloadLabel
                      : intl.formatMessage(globalMessages.deleted),
                  }
                )}
              </span>
              {inProgress && (
                <>
                  {episodeLabel && <span className="ml-1">{episodeLabel}</span>}
                  {downloadBusy && <Spinner className="ml-1 h-3 w-3" />}
                </>
              )}
            </div>
          </Badge>
        </Tooltip>
      );

    default:
      return null;
  }
};

export default StatusBadge;
