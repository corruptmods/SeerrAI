import { describeEta } from '@app/components/RequestEta';
import useFeature from '@app/hooks/useFeature';
import type { RequestEta } from '@app/hooks/useRequestEtas';
import useRequestEtas, { etaRefreshInterval } from '@app/hooks/useRequestEtas';
import { Permission, useUser } from '@app/hooks/useUser';
import { ClockIcon } from '@heroicons/react/24/outline';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

/**
 * On a title page, when the request that matters to the viewer should
 * arrive: their own most recent active request, or for someone who manages
 * requests, the most recent active one. Nothing when there is nothing useful
 * to say.
 */
const TitleEta = ({
  requests,
  media,
}: {
  requests?: MediaRequest[];
  /**
   * The title itself: when it is being processed with no request behind it —
   * added in Radarr or Sonarr directly — its own estimate is shown.
   */
  media?: Media;
}) => {
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const seesAll = hasPermission(
    [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
    { type: 'or' }
  );

  const active = (requests ?? [])
    .filter(
      (request) =>
        (request.status === MediaRequestStatus.PENDING ||
          request.status === MediaRequestStatus.APPROVED) &&
        (seesAll || request.requestedBy?.id === user?.id)
    )
    .sort(
      (a, b) =>
        // The viewer's own first, then the most recent.
        Number(b.requestedBy?.id === user?.id) -
          Number(a.requestedBy?.id === user?.id) ||
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

  const chosen = active[0];
  const etaFor = useRequestEtas(chosen ? [chosen.id] : []);

  // No request to go by: the title's own estimate, while it is processing.
  const processing4k =
    media?.status !== MediaStatus.PROCESSING &&
    media?.status4k === MediaStatus.PROCESSING;
  const on = useFeature('arrivalEstimates');
  const titleKey =
    on &&
    !chosen &&
    media?.id &&
    (media.status === MediaStatus.PROCESSING || processing4k)
      ? `/api/v1/media/${media.id}/eta?is4k=${processing4k}`
      : null;
  const { data: titleEta } = useSWR<RequestEta>(titleKey, {
    refreshInterval: (latest) => etaRefreshInterval([latest]),
    revalidateOnFocus: false,
  });

  const text = describeEta(
    intl,
    chosen ? etaFor(chosen.id) : titleKey ? titleEta : undefined
  );

  if (!text) {
    return null;
  }

  return (
    <p className="mt-2 flex items-center justify-center gap-1.5 text-sm text-gray-300 2xl:justify-start">
      <ClockIcon className="h-4 w-4 flex-none text-gray-400" />
      <span>{text}</span>
    </p>
  );
};

export default TitleEta;
