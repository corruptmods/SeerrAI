import { sliderTitles } from '@app/components/Discover/constants';
import RequestCard from '@app/components/RequestCard';
import PlaylistRequestCard from '@app/components/RequestCard/PlaylistRequestCard';
import Slider from '@app/components/Slider';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowRightCircleIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import type { RequestResultsResponse } from '@server/interfaces/api/requestInterfaces';
import Link from 'next/link';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.RecentRequestsSlider', {
  unableToConnect: 'Can’t reach {services}, so some details may be missing.',
});

/**
 * Latest video requests, or music ones with `music`, where a playlist import
 * is one card.
 */
const RecentRequestsSlider = ({ music = false }: { music?: boolean }) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const { data: requests, error: requestError } =
    useSWR<RequestResultsResponse>(
      // The API rejects an unencoded comma.
      `/api/v1/request?filter=all&take=10&sort=added&skip=0&${
        music
          ? 'mediaType=music&playlists=group'
          : `mediaType=${encodeURIComponent('movie,tv')}`
      }`,
      {
        revalidateOnMount: true,
        // Poll while a playlist has songs pending; request cards poll
        // themselves.
        refreshInterval: (latest) =>
          music &&
          latest?.playlists?.some(
            (group) => group.onTheWay + group.approval + group.waiting > 0
          )
            ? 15_000
            : 0,
      }
    );

  if (
    requests &&
    requests.results.length === 0 &&
    !requests.playlists?.length &&
    !requestError
  ) {
    return null;
  }

  const hasServiceErrors =
    !music &&
    requests?.serviceErrors &&
    (requests.serviceErrors.radarr.length > 0 ||
      requests.serviceErrors.sonarr.length > 0);

  return (
    <>
      <div className="slider-header">
        <Link href="/requests?filter=all" className="slider-title">
          <span>
            {intl.formatMessage(
              music
                ? sliderTitles.musicRecentRequests
                : sliderTitles.recentrequests
            )}
          </span>
          <ArrowRightCircleIcon />
        </Link>
      </div>

      {hasServiceErrors &&
        (hasPermission(Permission.MANAGE_REQUESTS) ||
          hasPermission(Permission.REQUEST_ADVANCED)) && (
          <div className="service-error-banner">
            <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0" />
            <span>
              {intl.formatMessage(messages.unableToConnect, {
                services: [
                  ...requests.serviceErrors.radarr.map((s) => s.name),
                  ...requests.serviceErrors.sonarr.map((s) => s.name),
                ].join(', '),
              })}
            </span>
          </div>
        )}

      <Slider
        sliderKey={music ? 'music-requests' : 'requests'}
        isLoading={!requests}
        items={[
          ...(requests?.results ?? []).map((request) => ({
            at: new Date(request.createdAt).getTime(),
            card: (
              <RequestCard
                key={`request-slider-item-${request.id}`}
                request={request}
              />
            ),
          })),
          ...(requests?.playlists ?? []).map((group) => ({
            at: new Date(group.latestAt).getTime(),
            card: (
              <PlaylistRequestCard
                key={`request-slider-playlist-${group.listId}`}
                group={group}
              />
            ),
          })),
        ]
          .sort((a, b) => b.at - a.at)
          .slice(0, 10)
          .map(({ card }) => card)}
        placeholder={<RequestCard.Placeholder />}
      />
    </>
  );
};

export default RecentRequestsSlider;
