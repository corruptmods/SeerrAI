import CachedImage from '@app/components/Common/CachedImage';
import {
  newestFirst,
  seasonGroups,
} from '@app/components/RequestedBy/requests';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { MediaRequestStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestedBy', {
  requestedBy: 'Requested by',
  is4k: '4K',
  seasons: '{count, plural, one {Season {list}} other {Seasons {list}}}',
  specials: 'Specials',
  showAll: 'and {count} more',
});

const SHOWN = 4;

const statusMessages: Record<MediaRequestStatus, keyof typeof globalMessages> =
  {
    [MediaRequestStatus.PENDING]: 'pending',
    [MediaRequestStatus.APPROVED]: 'approved',
    [MediaRequestStatus.DECLINED]: 'declined',
    [MediaRequestStatus.FAILED]: 'failed',
    [MediaRequestStatus.COMPLETED]: 'completed',
  };

// Whole class names so Tailwind keeps them; darker variants for light mode.
const statusColors: Record<MediaRequestStatus, string> = {
  [MediaRequestStatus.PENDING]: 'text-yellow-500 light:text-warning-text',
  [MediaRequestStatus.APPROVED]: 'text-green-400 light:text-success-text',
  [MediaRequestStatus.DECLINED]: 'text-red-400 light:text-danger-text',
  [MediaRequestStatus.FAILED]: 'text-red-400 light:text-danger-text',
  [MediaRequestStatus.COMPLETED]: 'text-green-400 light:text-success-text',
};

/**
 * Facts row of the title's requests, newest first: requester, scope (4K,
 * seasons), status and date, as filtered for the viewer by
 * lib/mediaForViewer. Nothing when unrequested.
 */
const RequestedBy = ({ requests }: { requests?: MediaRequest[] }) => {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(false);

  if (!requests?.length) {
    return null;
  }

  const sorted = newestFirst(requests);
  const shown = expanded ? sorted : sorted.slice(0, SHOWN);

  const seasonsOf = (request: MediaRequest) => {
    if (!request.seasons?.length) {
      return [];
    }
    const { specials, count, list } = seasonGroups(
      request.seasons.map((season) => season.seasonNumber)
    );
    return [
      ...(specials ? [intl.formatMessage(messages.specials)] : []),
      ...(count ? [intl.formatMessage(messages.seasons, { count, list })] : []),
    ];
  };

  return (
    <div className="media-fact" data-testid="requested-by">
      <span>{intl.formatMessage(messages.requestedBy)}</span>
      <span className="media-fact-value">
        {shown.map((request) => {
          const details = [
            ...(request.is4k ? [intl.formatMessage(messages.is4k)] : []),
            ...seasonsOf(request),
            intl.formatDate(request.createdAt, {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            }),
          ];
          return (
            <span
              key={`requested-by-${request.id}`}
              className="mb-1 block last:mb-0"
            >
              {request.requestedBy && (
                <Link
                  href={`/users/${request.requestedBy.id}`}
                  className="group inline-flex items-center"
                >
                  <CachedImage
                    type="avatar"
                    src={request.requestedBy.avatar}
                    alt=""
                    className="avatar-sm object-cover"
                    width={20}
                    height={20}
                  />
                  <span className="text-gray-200">
                    {request.requestedBy.displayName}
                  </span>
                </Link>
              )}
              <span className="block text-xs text-muted">
                <span className={statusColors[request.status]}>
                  {intl.formatMessage(
                    globalMessages[statusMessages[request.status] ?? 'pending']
                  )}
                </span>
                {details.map((detail) => ` · ${detail}`).join('')}
              </span>
            </span>
          );
        })}
        {!expanded && sorted.length > SHOWN && (
          <button
            type="button"
            className="block text-accent-soft hover:text-indigo-300 light:text-accent-text light:hover:text-accent-text"
            onClick={() => setExpanded(true)}
          >
            {intl.formatMessage(messages.showAll, {
              count: sorted.length - SHOWN,
            })}
          </button>
        )}
      </span>
    </div>
  );
};

export default RequestedBy;
