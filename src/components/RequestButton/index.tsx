import ButtonWithDropdown from '@app/components/Common/ButtonWithDropdown';
import DeclineRequestModal from '@app/components/DeclineRequestModal';
import RequestModal from '@app/components/RequestModal';
import usePushDeviceState from '@app/hooks/usePushDeviceState';
import useRequestAction from '@app/hooks/useRequestAction';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { oneAfterAnother } from '@app/utils/requestActions';
import {
  ArrowDownTrayIcon,
  BellAlertIcon,
  BellSlashIcon,
} from '@heroicons/react/24/outline';
import {
  CheckIcon,
  InformationCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.RequestButton', {
  viewrequest: 'View Request',
  notifyme: 'Notify Me When Available',
  notifyingme: 'You Will Be Notified',
  enablenotifications: 'Enable Notifications To Be Notified',
  viewrequest4k: 'View 4K Request',
  requestmore: 'Request More',
  requestmore4k: 'Request More in 4K',
  approverequest: 'Approve Request',
  approverequest4k: 'Approve 4K Request',
  declinerequest: 'Decline Request',
  declinerequest4k: 'Decline 4K Request',
  approverequests:
    'Approve {requestCount, plural, one {Request} other {{requestCount} Requests}}',
  declinerequests:
    'Decline {requestCount, plural, one {Request} other {{requestCount} Requests}}',
  approve4krequests:
    'Approve {requestCount, plural, one {4K Request} other {{requestCount} 4K Requests}}',
  decline4krequests:
    'Decline {requestCount, plural, one {4K Request} other {{requestCount} 4K Requests}}',
});

interface ButtonOption {
  id: string;
  text: string;
  action: () => void;
  svg?: React.ReactNode;
}

interface RequestButtonProps {
  mediaType: 'movie' | 'tv';
  onUpdate: () => void;
  tmdbId: number;
  media?: Media;
  isShowComplete?: boolean;
  is4kShowComplete?: boolean;
}

const RequestButton = ({
  tmdbId,
  onUpdate,
  media,
  mediaType,
  isShowComplete = false,
  is4kShowComplete = false,
}: RequestButtonProps) => {
  const intl = useIntl();
  const { mutate: globalMutate } = useSWRConfig();
  const settings = useSettings();
  const router = useRouter();
  const { user, hasPermission } = useUser();
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [showRequest4kModal, setShowRequest4kModal] = useState(false);
  const [editRequest, setEditRequest] = useState(false);
  // Kept while the dialog closes, so it does not change as it fades out.
  const [declining, setDeclining] = useState<{
    show: boolean;
    requests: MediaRequest[];
  }>({ show: false, requests: [] });
  const declineRequests = (requests: MediaRequest[]) =>
    setDeclining({ show: true, requests });

  // All pending requests
  const activeRequests = media?.requests.filter(
    (request) => request.status === MediaRequestStatus.PENDING && !request.is4k
  );
  const active4kRequests = media?.requests.filter(
    (request) => request.status === MediaRequestStatus.PENDING && request.is4k
  );

  // Any request that has not finished yet: a user wants notifying whether it
  // is still awaiting approval or already downloading. `activeRequest` below
  // is pending-only, which is not the right set for this.
  const watchableRequest = useMemo(
    () =>
      // Nothing to wait for once it is here. A request can sit at APPROVED
      // after the media has landed, which is why the request status alone is
      // not enough to decide this.
      media?.status === MediaStatus.AVAILABLE
        ? undefined
        : media?.requests.find(
            (request) =>
              !request.is4k &&
              (request.status === MediaRequestStatus.PENDING ||
                request.status === MediaRequestStatus.APPROVED)
          ),
    [media]
  );

  // Current user's pending request, or the first pending request
  const activeRequest = useMemo(() => {
    return activeRequests && activeRequests.length > 0
      ? (activeRequests.find(
          (request) => request.requestedBy.id === user?.id
        ) ?? activeRequests[0])
      : undefined;
  }, [activeRequests, user]);
  const active4kRequest = useMemo(() => {
    return active4kRequests && active4kRequests.length > 0
      ? (active4kRequests.find(
          (request) => request.requestedBy.id === user?.id
        ) ?? active4kRequests[0])
      : undefined;
  }, [active4kRequests, user]);

  const { run } = useRequestAction();

  const approveRequest = (request: MediaRequest) =>
    run(async () => {
      await axios.post(`/api/v1/request/${request.id}/approve`);
      onUpdate();
      globalMutate('/api/v1/request/count');
    });

  // One after another, as declining them is, and what did go through is
  // shown even when one of them could not be approved.
  const approveRequests = (requests: MediaRequest[]) =>
    run(async () => {
      const errors = await oneAfterAnother(requests, (request) =>
        axios.post(`/api/v1/request/${request.id}/approve`)
      );
      onUpdate();
      globalMutate('/api/v1/request/count');
      if (errors.length) {
        throw errors[0];
      }
    });

  const { data: watchState, mutate: revalidateWatch } = useSWR<{
    watching: boolean;
    isRequester?: boolean;
    reachable: boolean;
  }>(watchableRequest ? `/api/v1/request/${watchableRequest.id}/watch` : null);

  const isWatching = watchState?.watching ?? false;
  // The offer to watch never depends on this fetch: if it is slow or fails,
  // the button still appears. The fetch only refines it — flipping to
  // "You Will Be Notified" once watching, or to the enable prompt when the
  // server has positively reported the user has no notification channel.
  const isUnreachable = watchState?.reachable === false;
  const { state: pushState, subscribe: subscribeToPush } = usePushDeviceState();

  const watchRequest = async (requestId: number) => {
    try {
      await axios.post(`/api/v1/request/${requestId}/watch`);
    } catch (e) {
      // 400 means no notification channel; let the reachability state take
      // over so the button becomes the enable prompt.
      if (axios.isAxiosError(e) && e.response?.status === 400) {
        revalidateWatch();
        return;
      }

      throw e;
    }

    revalidateWatch();
    onUpdate();
  };

  const unwatchRequest = async (requestId: number) => {
    await axios.delete(`/api/v1/request/${requestId}/watch`);
    revalidateWatch();
    onUpdate();
  };

  const buttons: ButtonOption[] = [];

  // Someone else already requested this, so a second request is refused.
  // Offer to be notified alongside the original requester instead.
  if (watchableRequest && user?.id && isUnreachable) {
    buttons.push({
      id: 'enable-notifications',
      text: intl.formatMessage(messages.enablenotifications),
      action: async () => {
        // This device can be asked for notifications right here. Otherwise
        // (already asked and refused, not installed, not supported) it is
        // set up on their notification settings, where every way of being
        // told is offered.
        if (pushState === 'prompt') {
          const subscribed = await subscribeToPush();

          if (subscribed) {
            revalidateWatch();
          }
          return;
        }

        router.push(
          settings.currentSettings.enablePushRegistration
            ? '/profile/settings/notifications/webpush'
            : settings.currentSettings.emailEnabled
              ? '/profile/settings/notifications/email'
              : '/profile/settings/notifications/discord'
        );
      },
      svg: <BellAlertIcon />,
    });
  }

  if (watchableRequest && user?.id && !isUnreachable) {
    buttons.push(
      isWatching
        ? {
            id: 'unwatch-request',
            text: intl.formatMessage(messages.notifyingme),
            action: () => unwatchRequest(watchableRequest.id),
            svg: <BellSlashIcon />,
          }
        : {
            id: 'watch-request',
            text: intl.formatMessage(messages.notifyme),
            action: () => watchRequest(watchableRequest.id),
            svg: <BellAlertIcon />,
          }
    );
  }

  // If there are pending requests, show request management options first
  if (activeRequest || active4kRequest) {
    if (
      activeRequest &&
      (activeRequest.requestedBy.id === user?.id ||
        (activeRequests?.length === 1 &&
          hasPermission(Permission.MANAGE_REQUESTS)))
    ) {
      buttons.push({
        id: 'active-request',
        text: intl.formatMessage(messages.viewrequest),
        action: () => {
          setEditRequest(true);
          setShowRequestModal(true);
        },
        svg: <InformationCircleIcon />,
      });
    }

    if (
      activeRequest &&
      hasPermission(Permission.MANAGE_REQUESTS) &&
      mediaType === 'movie'
    ) {
      buttons.push(
        {
          id: 'approve-request',
          text: intl.formatMessage(messages.approverequest),
          action: () => {
            approveRequest(activeRequest);
          },
          svg: <CheckIcon />,
        },
        {
          id: 'decline-request',
          text: intl.formatMessage(messages.declinerequest),
          action: () => {
            declineRequests([activeRequest]);
          },
          svg: <XMarkIcon />,
        }
      );
    } else if (
      activeRequests &&
      activeRequests.length > 0 &&
      hasPermission(Permission.MANAGE_REQUESTS) &&
      mediaType === 'tv'
    ) {
      buttons.push(
        {
          id: 'approve-request-batch',
          text: intl.formatMessage(messages.approverequests, {
            requestCount: activeRequests.length,
          }),
          action: () => {
            approveRequests(activeRequests);
          },
          svg: <CheckIcon />,
        },
        {
          id: 'decline-request-batch',
          text: intl.formatMessage(messages.declinerequests, {
            requestCount: activeRequests.length,
          }),
          action: () => {
            declineRequests(activeRequests);
          },
          svg: <XMarkIcon />,
        }
      );
    }

    if (
      active4kRequest &&
      (active4kRequest.requestedBy.id === user?.id ||
        (active4kRequests?.length === 1 &&
          hasPermission(Permission.MANAGE_REQUESTS)))
    ) {
      buttons.push({
        id: 'active-4k-request',
        text: intl.formatMessage(messages.viewrequest4k),
        action: () => {
          setEditRequest(true);
          setShowRequest4kModal(true);
        },
        svg: <InformationCircleIcon />,
      });
    }

    if (
      active4kRequest &&
      hasPermission(Permission.MANAGE_REQUESTS) &&
      mediaType === 'movie'
    ) {
      buttons.push(
        {
          id: 'approve-4k-request',
          text: intl.formatMessage(messages.approverequest4k),
          action: () => {
            approveRequest(active4kRequest);
          },
          svg: <CheckIcon />,
        },
        {
          id: 'decline-4k-request',
          text: intl.formatMessage(messages.declinerequest4k),
          action: () => {
            declineRequests([active4kRequest]);
          },
          svg: <XMarkIcon />,
        }
      );
    } else if (
      active4kRequests &&
      active4kRequests.length > 0 &&
      hasPermission(Permission.MANAGE_REQUESTS) &&
      mediaType === 'tv'
    ) {
      buttons.push(
        {
          id: 'approve-4k-request-batch',
          text: intl.formatMessage(messages.approve4krequests, {
            requestCount: active4kRequests.length,
          }),
          action: () => {
            approveRequests(active4kRequests);
          },
          svg: <CheckIcon />,
        },
        {
          id: 'decline-4k-request-batch',
          text: intl.formatMessage(messages.decline4krequests, {
            requestCount: active4kRequests.length,
          }),
          action: () => {
            declineRequests(active4kRequests);
          },
          svg: <XMarkIcon />,
        }
      );
    }
  }

  // Standard request button
  if (
    (!media ||
      media.status === MediaStatus.UNKNOWN ||
      (media.status === MediaStatus.DELETED && !activeRequest)) &&
    hasPermission(
      [
        Permission.REQUEST,
        mediaType === 'movie'
          ? Permission.REQUEST_MOVIE
          : Permission.REQUEST_TV,
      ],
      { type: 'or' }
    )
  ) {
    buttons.push({
      id: 'request',
      text: intl.formatMessage(globalMessages.request),
      action: () => {
        setEditRequest(false);
        setShowRequestModal(true);
      },
      svg: <ArrowDownTrayIcon />,
    });
  } else if (
    mediaType === 'tv' &&
    (!activeRequest || activeRequest.requestedBy.id !== user?.id) &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_TV], {
      type: 'or',
    }) &&
    media &&
    media.status !== MediaStatus.BLOCKLISTED &&
    !isShowComplete
  ) {
    buttons.push({
      id: 'request-more',
      text: intl.formatMessage(messages.requestmore),
      action: () => {
        setEditRequest(false);
        setShowRequestModal(true);
      },
      svg: <ArrowDownTrayIcon />,
    });
  }

  // 4K request button
  if (
    (!media ||
      media.status4k === MediaStatus.UNKNOWN ||
      (media.status4k === MediaStatus.DELETED && !active4kRequest)) &&
    hasPermission(
      [
        Permission.REQUEST_4K,
        mediaType === 'movie'
          ? Permission.REQUEST_4K_MOVIE
          : Permission.REQUEST_4K_TV,
      ],
      { type: 'or' }
    ) &&
    ((settings.currentSettings.movie4kEnabled && mediaType === 'movie') ||
      (settings.currentSettings.series4kEnabled && mediaType === 'tv'))
  ) {
    buttons.push({
      id: 'request4k',
      text: intl.formatMessage(globalMessages.request4k),
      action: () => {
        setEditRequest(false);
        setShowRequest4kModal(true);
      },
      svg: <ArrowDownTrayIcon />,
    });
  } else if (
    mediaType === 'tv' &&
    (!active4kRequest || active4kRequest.requestedBy.id !== user?.id) &&
    hasPermission([Permission.REQUEST_4K, Permission.REQUEST_4K_TV], {
      type: 'or',
    }) &&
    media &&
    media.status4k !== MediaStatus.BLOCKLISTED &&
    !is4kShowComplete &&
    settings.currentSettings.series4kEnabled
  ) {
    buttons.push({
      id: 'request-more-4k',
      text: intl.formatMessage(messages.requestmore4k),
      action: () => {
        setEditRequest(false);
        setShowRequest4kModal(true);
      },
      svg: <ArrowDownTrayIcon />,
    });
  }

  const [buttonOne, ...others] = buttons;

  const declineModal = (
    <DeclineRequestModal
      show={declining.show}
      requests={declining.requests}
      onCancel={() => setDeclining((d) => ({ ...d, show: false }))}
      onComplete={() => {
        setDeclining((d) => ({ ...d, show: false }));
        onUpdate();
      }}
    />
  );

  if (!buttonOne) {
    return declineModal;
  }

  return (
    <>
      {declineModal}
      <RequestModal
        tmdbId={tmdbId}
        show={showRequestModal}
        type={mediaType}
        editRequest={editRequest ? activeRequest : undefined}
        onComplete={() => {
          onUpdate();
          setShowRequestModal(false);
        }}
        onCancel={() => setShowRequestModal(false)}
      />
      <RequestModal
        tmdbId={tmdbId}
        show={showRequest4kModal}
        type={mediaType}
        editRequest={editRequest ? active4kRequest : undefined}
        is4k
        onComplete={() => {
          onUpdate();
          setShowRequest4kModal(false);
        }}
        onCancel={() => setShowRequest4kModal(false)}
      />
      <ButtonWithDropdown
        text={
          <>
            {buttonOne.svg}
            <span>{buttonOne.text}</span>
          </>
        }
        onClick={buttonOne.action}
      >
        {others && others.length > 0
          ? others.map((button) => (
              <ButtonWithDropdown.Item
                onClick={button.action}
                key={`request-option-${button.id}`}
              >
                {button.svg}
                <span>{button.text}</span>
              </ButtonWithDropdown.Item>
            ))
          : null}
      </ButtonWithDropdown>
    </>
  );
};

export default RequestButton;
