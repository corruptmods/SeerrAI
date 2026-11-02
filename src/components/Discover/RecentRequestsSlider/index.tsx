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
 * The latest requests: films' and series', or with `music` music's, where
 * a playlist import's songs are one card rather than a card each.
 */
const RecentRequestsSlider = ({ music = false }: { music?: boolean }) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const { data: requests, error: requestError } =
    useSWR<RequestResultsResponse>(
      // A comma is sent encoded: the API refuses one written plainly.
      `/api/v1/request?filter=all&take=10&sort=added&skip=0&${
        music
          ? 'mediaType=music&playlists=group'
          : `mediaType=${encodeURIComponent('movie,tv')}`
      }`,
      {
        revalidateOnMount: true,
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

  // Radarr and Sonarr have no part in music's.
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
