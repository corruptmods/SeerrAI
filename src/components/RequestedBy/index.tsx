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

// Whole class names, so the stylesheet keeps them.
const statusColors: Record<MediaRequestStatus, string> = {
  [MediaRequestStatus.PENDING]: 'text-yellow-500',
  [MediaRequestStatus.APPROVED]: 'text-green-400',
  [MediaRequestStatus.DECLINED]: 'text-red-400',
  [MediaRequestStatus.FAILED]: 'text-red-400',
  [MediaRequestStatus.COMPLETED]: 'text-green-400',
};

/**
 * Who asked for this title, as a row in the title's facts: each request
 * with its requester, newest first, and what it was for (4K, which
 * seasons), how it stands and when it was made. Only what the server sends
 * for the person looking (lib/mediaForViewer). Nothing when no one has
 * requested it.
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
              <span className="block text-xs text-gray-400">
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
            className="block text-indigo-400 hover:text-indigo-300"
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
