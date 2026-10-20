import Spinner from '@app/assets/spinner.svg';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import Tooltip from '@app/components/Common/Tooltip';
import DeclineReason from '@app/components/DeclineReason';
import DeclineRequestModal from '@app/components/DeclineRequestModal';
import MusicImage from '@app/components/Music/MusicImage';
import {
  AlbumsField,
  MusicRequestBadge,
  musicRequestHref,
  musicRequestImage,
  musicRequestTitle,
  useMusicRequest,
} from '@app/components/Music/MusicRequest/shared';
import RequestModal from '@app/components/RequestModal';
import RequestServerIssue from '@app/components/RequestServerIssue';
import useNearScreen, { NearScreen, bothRefs } from '@app/hooks/useNearScreen';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  CheckIcon,
  PencilIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import { MediaRequestStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Music.MusicRequestCard', {
  approverequest: 'Approve Request',
  declinerequest: 'Decline Request',
  editrequest: 'Edit Request',
  cancelrequest: 'Cancel Request',
});

/**
 * A music request in a row of request cards (Recent Requests, someone's
 * profile): the artist and album or how many, the album's cover or the
 * artist's picture, where the albums are, and what can be done with it.
 */
const MusicRequestCard = ({
  request,
}: {
  request: NonFunctionProperties<MediaRequest>;
}) => {
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  // On screen now, for checking on the request; near the screen, for
  // loading its picture before it is scrolled to.
  const { ref: viewRef, inView } = useInView();
  const { ref: nearRef, nearness } = useNearScreen();
  const ref = useMemo(() => bothRefs(viewRef, nearRef), [viewRef, nearRef]);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const {
    requestData,
    revalidate,
    approve,
    retry,
    remove,
    isApproving,
    isRetrying,
  } = useMusicRequest(request, inView);

  const title = musicRequestTitle(requestData, intl);
  const href = musicRequestHref(requestData);
  const pending = requestData.status === MediaRequestStatus.PENDING;
  const manages = hasPermission(Permission.MANAGE_REQUESTS);
  const isOwner = requestData.requestedBy?.id === user?.id;

  return (
    <>
      {requestData.media?.foreignId && (
        <RequestModal
          type="music"
          show={showEditModal}
          artistMbid={requestData.media.foreignId}
          editRequest={requestData}
          onCancel={() => setShowEditModal(false)}
          onComplete={() => {
            revalidate();
            setShowEditModal(false);
          }}
        />
      )}
      <DeclineRequestModal
        show={showDeclineModal}
        requests={[requestData]}
        subTitle={title}
        onCancel={() => setShowDeclineModal(false)}
        onComplete={() => {
          setShowDeclineModal(false);
          revalidate();
        }}
      />
      <div
        className="relative flex w-72 overflow-hidden rounded-xl bg-surface p-4 text-muted shadow ring-1 ring-subtle sm:w-96"
        data-testid="request-card"
        ref={ref}
      >
        <div
          className="relative z-10 flex min-w-0 flex-1 flex-col pr-4"
          data-testid="request-card-title"
        >
          <div className="hidden text-xs font-medium text-strong sm:flex">
            {intl.formatMessage(globalMessages.music)}
          </div>
          <Link
            href={href}
            className="overflow-hidden overflow-ellipsis whitespace-nowrap text-base font-bold text-strong hover:underline sm:text-lg"
          >
            {title}
          </Link>
          {hasPermission(
            [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
            { type: 'or' }
          ) &&
            requestData.requestedBy && (
              <div className="card-field">
                <Link
                  href={`/users/${requestData.requestedBy.id}`}
                  className="group flex items-center"
                >
                  <span className="avatar-sm">
                    <CachedImage
                      type="avatar"
                      src={requestData.requestedBy.avatar}
                      alt=""
                      className="avatar-sm object-cover"
                      width={20}
                      height={20}
                    />
                  </span>
                  <span className="truncate font-semibold group-hover:text-strong group-hover:underline">
                    {requestData.requestedBy.displayName}
                  </span>
                </Link>
              </div>
            )}
          <AlbumsField
            request={requestData}
            className="my-0.5 hidden items-center gap-2 text-sm sm:my-1 sm:flex"
          />
          <div className="mt-2 flex items-center text-sm sm:mt-1">
            <span className="mr-2 hidden font-bold sm:block">
              {intl.formatMessage(globalMessages.status)}
            </span>
            <MusicRequestBadge request={requestData} />
          </div>
          {requestData.status === MediaRequestStatus.DECLINED &&
            requestData.declineReason && (
              <DeclineReason
                reason={requestData.declineReason}
                className="mt-1"
              />
            )}
          <RequestServerIssue request={requestData} compact className="mt-1" />
          <div className="flex flex-1 items-end space-x-2">
            {requestData.status === MediaRequestStatus.FAILED && manages && (
              <>
                <Tooltip content={intl.formatMessage(globalMessages.retry)}>
                  <Button
                    buttonType="primary"
                    buttonSize="sm"
                    disabled={isRetrying}
                    onClick={() => retry()}
                  >
                    <ArrowPathIcon
                      className={isRetrying ? 'animate-spin' : ''}
                      style={{
                        marginRight: '0',
                        animationDirection: 'reverse',
                      }}
                    />
                  </Button>
                </Tooltip>
                {/* Another Lidarr, profile or folder, before retrying. */}
                <Tooltip content={intl.formatMessage(messages.editrequest)}>
                  <Button
                    buttonType="default"
                    buttonSize="sm"
                    disabled={isRetrying}
                    onClick={() => setShowEditModal(true)}
                  >
                    <PencilIcon />
                  </Button>
                </Tooltip>
              </>
            )}
            {pending && manages && (
              <>
                <Tooltip content={intl.formatMessage(messages.approverequest)}>
                  <Button
                    buttonType="success"
                    buttonSize="sm"
                    onClick={() => approve()}
                    disabled={isApproving}
                  >
                    {isApproving ? <Spinner /> : <CheckIcon />}
                  </Button>
                </Tooltip>
                <Tooltip content={intl.formatMessage(messages.declinerequest)}>
                  <Button
                    buttonType="danger"
                    buttonSize="sm"
                    onClick={() => setShowDeclineModal(true)}
                    disabled={isApproving}
                  >
                    <XMarkIcon />
                  </Button>
                </Tooltip>
              </>
            )}
            {pending && (manages || isOwner) && (
              <Tooltip content={intl.formatMessage(messages.editrequest)}>
                <Button
                  buttonType="primary"
                  buttonSize="sm"
                  onClick={() => setShowEditModal(true)}
                  disabled={isApproving}
                >
                  <PencilIcon />
                </Button>
              </Tooltip>
            )}
            {pending && !manages && isOwner && (
              <Tooltip content={intl.formatMessage(messages.cancelrequest)}>
                <Button
                  buttonType="danger"
                  buttonSize="sm"
                  onClick={() => remove()}
                >
                  <XMarkIcon />
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
        <Link
          href={href}
          className="w-20 flex-shrink-0 self-start overflow-hidden rounded-md shadow-sm sm:w-28"
          // The title on the card is the same link.
          tabIndex={-1}
          aria-hidden
        >
          <div className="relative w-full" style={{ paddingBottom: '100%' }}>
            <NearScreen.Provider value={nearness}>
              <MusicImage
                src={musicRequestImage(requestData)}
                fallback={requestData.albums?.length === 1 ? 'album' : 'artist'}
                sizes="7rem"
              />
            </NearScreen.Provider>
          </div>
        </Link>
      </div>
    </>
  );
};

export default MusicRequestCard;
