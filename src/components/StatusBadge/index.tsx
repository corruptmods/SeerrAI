import Spinner from '@app/assets/spinner.svg';
import Badge from '@app/components/Common/Badge';
import Tooltip from '@app/components/Common/Tooltip';
import DownloadBlock from '@app/components/DownloadBlock';
import { useIsTouch } from '@app/hooks/useIsTouch';
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
import { SERVER_NAMES } from '@app/utils/mediaServerAccounts';
import type { PlayTarget } from '@app/utils/playLinks';
import { viewerServer } from '@app/utils/playLinks';
import { MediaStatus } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import Link from 'next/link';
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
  showDownload: '{status}: show the download',
});

interface StatusBadgeProps {
  status?: MediaStatus;
  downloadItem?: DownloadingItem[];
  is4k?: boolean;
  inProgress?: boolean;
  /** Where the viewer can play this version of the title (usePlayLinks). */
  playLink?: PlayTarget;
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
  playLink,
  serviceUrl,
  tmdbId,
  mediaType,
  title,
  statusLabelOverride,
}: StatusBadgeProps) => {
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const settings = useSettings();
  // On a touchscreen there is no hover to show a download's details, so a
  // pill that is downloading opens them when tapped, rather than following
  // its link (to Plex, or the manage panel); the link is then inside.
  const isTouch = useIsTouch();

  let mediaLink: string | undefined;
  let mediaLinkDescription: string | undefined;

  // The server a finished download is being added to, as far as the viewer
  // is concerned: the one they would play it on.
  const watchServer = viewerServer(user, settings.currentSettings.mediaServers);
  const mediaServerName = watchServer ? SERVER_NAMES[watchServer] : '';

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
    playLink &&
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
    mediaLink = playLink.url;
    mediaLinkDescription = intl.formatMessage(messages.playonplex, {
      mediaServerName: playLink.name,
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

  /** Where the details' link goes, as a row at their foot. */
  const detailsLink =
    mediaLink && mediaLinkDescription ? (
      <div className="border-t border-gray-700 py-2 text-right">
        {mediaLink.includes('://') ? (
          <a
            href={mediaLink}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-indigo-400 hover:text-indigo-300"
          >
            {mediaLinkDescription}
          </a>
        ) : (
          <Link
            href={mediaLink}
            className="font-semibold text-indigo-400 hover:text-indigo-300"
          >
            {mediaLinkDescription}
          </Link>
        )}
      </div>
    ) : null;

  /**
   * A pill that shows a download's progress while there is one: its
   * details on hover (or on a tap, on a touchscreen), and otherwise the
   * status it stands for.
   */
  const progressBadge = (
    badgeType: 'success' | 'primary' | 'danger',
    idleLabel: string
  ) => {
    const tapForDetails = inProgress && isTouch;
    const badge = (
      <Badge
        badgeType={badgeType}
        href={tapForDetails ? undefined : mediaLink}
        className={`${
          inProgress && 'relative !bg-gray-700/80 !px-0 hover:!bg-gray-700'
        } overflow-hidden`}
      >
        {inProgress && badgeDownloadProgress}
        <div
          className={`relative z-20 flex items-center ${inProgress && 'px-2'}`}
        >
          <span>
            {intl.formatMessage(is4k ? messages.status4k : messages.status, {
              status: inProgress ? downloadLabel : idleLabel,
            })}
          </span>
          {inProgress && (
            <>
              {episodeLabel && <span className="ml-1">{episodeLabel}</span>}
              {downloadBusy && <Spinner className="ml-1 h-3 w-3" />}
            </>
          )}
        </div>
      </Badge>
    );
    return (
      <Tooltip
        content={
          inProgress ? (
            <>
              {tooltipContent}
              {tapForDetails && detailsLink}
            </>
          ) : (
            mediaLinkDescription
          )
        }
        className={
          inProgress
            ? 'max-h-96 w-96 max-w-[calc(100vw-1rem)] overflow-y-auto'
            : undefined
        }
        tooltipConfig={{
          ...(inProgress && { interactive: true, delayHide: 100 }),
          ...(tapForDetails && {
            trigger: 'click',
            followCursor: false,
            placement: 'bottom',
            offset: [0, 8],
          }),
        }}
      >
        {tapForDetails ? (
          <button
            type="button"
            className="rounded-full"
            aria-label={intl.formatMessage(messages.showDownload, {
              status: downloadLabel,
            })}
          >
            {badge}
          </button>
        ) : (
          badge
        )}
      </Tooltip>
    );
  };

  switch (status) {
    case MediaStatus.AVAILABLE:
      return progressBadge(
        'success',
        intl.formatMessage(globalMessages.available)
      );

    case MediaStatus.PARTIALLY_AVAILABLE:
      return progressBadge(
        'success',
        intl.formatMessage(globalMessages.partiallyavailable)
      );

    case MediaStatus.PROCESSING:
      return progressBadge(
        'primary',
        intl.formatMessage(globalMessages.requested)
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
      return progressBadge(
        'danger',
        intl.formatMessage(globalMessages.deleted)
      );

    default:
      return null;
  }
};

export default StatusBadge;
