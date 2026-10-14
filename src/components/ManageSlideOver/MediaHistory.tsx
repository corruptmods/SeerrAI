import Badge from '@app/components/Common/Badge';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  CheckBadgeIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  MagnifyingGlassIcon,
  MinusCircleIcon,
  PlusCircleIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TrashIcon,
  XCircleIcon,
} from '@heroicons/react/24/solid';
import type { ComponentType, SVGProps } from 'react';
import { useState } from 'react';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.ManageSlideOver.MediaHistory', {
  history: 'History',
  byUser: '{event} by {user}',
  requested: 'Requested',
  approved: 'Approved',
  declined: 'Declined',
  failed: 'Could not be sent',
  processing: 'Processing',
  partially_available: 'Partially available',
  available: 'Available',
  removed: 'Removed from the library',
  files_removed: 'Files deleted',
  blocklisted: 'Blocklisted',
  unblocklisted: 'Removed from the blocklist',
  kept: 'Kept from deletion',
  searched: 'Searched for what was missing',
  monitoring_failed: 'Sonarr monitoring not updated',
  agent: 'The admin agent looked for it',
  added: 'Added to the library',
  fromService: 'From {service}',
  onServer: 'On {server}',
  showAll: 'Show all {count}',
});

interface HistoryEvent {
  id: number;
  type: keyof typeof ICONS;
  is4k: boolean;
  detail: string | null;
  occurredAt: string;
  user: { id: number; displayName: string; avatar: string } | null;
}

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

// Class names written out in full: assembled ones are stripped from the
// production stylesheet.
const ICONS: Record<string, { icon: Icon; className: string }> = {
  requested: { icon: ArrowDownTrayIcon, className: 'text-indigo-400' },
  approved: { icon: CheckCircleIcon, className: 'text-green-400' },
  declined: { icon: XCircleIcon, className: 'text-red-400' },
  failed: { icon: ExclamationTriangleIcon, className: 'text-red-400' },
  processing: { icon: ArrowPathIcon, className: 'text-indigo-400' },
  partially_available: { icon: CheckBadgeIcon, className: 'text-green-400' },
  available: { icon: CheckBadgeIcon, className: 'text-green-400' },
  removed: { icon: MinusCircleIcon, className: 'text-gray-400' },
  files_removed: { icon: TrashIcon, className: 'text-red-400' },
  blocklisted: { icon: EyeSlashIcon, className: 'text-red-400' },
  unblocklisted: { icon: EyeIcon, className: 'text-gray-400' },
  kept: { icon: ShieldCheckIcon, className: 'text-green-400' },
  searched: { icon: MagnifyingGlassIcon, className: 'text-indigo-400' },
  monitoring_failed: {
    icon: ExclamationTriangleIcon,
    className: 'text-yellow-400',
  },
  agent: { icon: SparklesIcon, className: 'text-indigo-300' },
  added: { icon: PlusCircleIcon, className: 'text-green-400' },
};

const SHOWN_AT_FIRST = 10;

/** A film or series by its TMDB id, or an artist by their MusicBrainz id. */
type MediaHistoryProps =
  | { tmdbId: number; mediaType: 'movie' | 'tv' }
  | { artistId: string };

/**
 * What has happened to a title, newest first: requests and their approval,
 * processing and availability, removals, blocklisting and keeps, with who
 * did it. Keyed by the title, so it survives Seerr deleting the media row.
 * For an artist, each album arriving or leaving names the album.
 */
const MediaHistory = (props: MediaHistoryProps) => {
  const intl = useIntl();
  const [showAll, setShowAll] = useState(false);
  const { data } = useSWR<HistoryEvent[]>(
    'artistId' in props
      ? `/api/v1/music/artist/${props.artistId}/history`
      : `/api/v1/media/history/${props.mediaType}/${props.tmdbId}`
  );

  if (!data?.length) {
    return null;
  }

  const shown = showAll ? data : data.slice(0, SHOWN_AT_FIRST);

  const detailFor = (event: HistoryEvent) => {
    if (!event.detail) {
      return null;
    }
    if (event.type === 'files_removed') {
      return intl.formatMessage(messages.fromService, {
        service: event.detail,
      });
    }
    if (event.type === 'kept') {
      return intl.formatMessage(messages.onServer, { server: event.detail });
    }
    return event.detail;
  };

  return (
    <div>
      <h3 className="mb-2 text-xl font-bold">
        {intl.formatMessage(messages.history)}
      </h3>
      <div className="overflow-hidden rounded-md border border-gray-700 shadow">
        <ul>
          {shown.map((event) => {
            const { icon: EventIcon, className } =
              ICONS[event.type] ?? ICONS.removed;
            const what = intl.formatMessage(
              messages[event.type as keyof typeof messages] ?? messages.removed
            );
            const when = new Date(event.occurredAt);
            const detail = detailFor(event);

            return (
              <li
                key={`history-${event.id}`}
                className="flex items-start space-x-3 border-b border-gray-700 px-4 py-3 last:border-b-0"
              >
                <EventIcon
                  className={`mt-0.5 h-5 w-5 flex-none ${className}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 text-sm text-gray-100">
                    <span>
                      {event.user
                        ? intl.formatMessage(messages.byUser, {
                            event: what,
                            user: event.user.displayName,
                          })
                        : what}
                    </span>
                    {event.is4k && <Badge badgeType="warning">4K</Badge>}
                  </div>
                  {detail && (
                    <p className="mt-0.5 break-words text-xs text-gray-400">
                      {detail}
                    </p>
                  )}
                </div>
                <time
                  className="flex-none whitespace-nowrap text-xs text-gray-400"
                  dateTime={event.occurredAt}
                  title={intl.formatDate(when, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                >
                  <FormattedRelativeTime
                    value={(when.getTime() - Date.now()) / 1000}
                    updateIntervalInSeconds={1}
                    numeric="auto"
                  />
                </time>
              </li>
            );
          })}
        </ul>
        {!showAll && data.length > SHOWN_AT_FIRST && (
          <button
            type="button"
            className="w-full border-t border-gray-700 px-4 py-2 text-sm text-indigo-400 hover:bg-gray-700/40 hover:text-indigo-300"
            onClick={() => setShowAll(true)}
          >
            {intl.formatMessage(messages.showAll, { count: data.length })}
          </button>
        )}
      </div>
    </div>
  );
};

export default MediaHistory;
