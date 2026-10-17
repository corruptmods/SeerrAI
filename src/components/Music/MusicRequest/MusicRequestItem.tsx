import Spinner from '@app/assets/spinner.svg';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import ConfirmButton from '@app/components/Common/ConfirmButton';
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
import useNearScreen, { NearScreen, bothRefs } from '@app/hooks/useNearScreen';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  CheckIcon,
  PencilIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import { MediaRequestStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { FormattedRelativeTime, useIntl } from 'react-intl';

const messages = defineMessages('components.Music.MusicRequestItem', {
  requested: 'Requested',
  modified: 'Modified',
  modifieduserdate: '{date} by {user}',
  editrequest: 'Edit Request',
  deleterequest: 'Delete Request',
  cancelRequest: 'Cancel Request',
});

const since = (date: Date | string) => (
  <FormattedRelativeTime
    value={Math.floor((new Date(date).getTime() - Date.now()) / 1000)}
    updateIntervalInSeconds={1}
    numeric="auto"
  />
);

const Person = ({
  person,
}: {
  person: { id: number; avatar: string; displayName: string };
}) => (
  <Link
    href={`/users/${person.id}`}
    className="group flex items-center truncate"
  >
    <span className="avatar-sm ml-1.5">
      <CachedImage
        type="avatar"
        src={person.avatar}
        alt=""
        className="avatar-sm object-cover"
        width={20}
        height={20}
      />
    </span>
    <span className="truncate text-sm font-semibold group-hover:text-strong group-hover:underline">
      {person.displayName}
    </span>
  </Link>
);

interface MusicRequestItemProps {
  request: NonFunctionProperties<MediaRequest>;
  revalidateList: () => void;
}

/**
 * A music request on the Requests page: the artist and album or how many,
 * where the albums are, who asked and when, and what can be done with it.
 */
const MusicRequestItem = ({
  request,
  revalidateList,
}: MusicRequestItemProps) => {
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
  const seesOthers = hasPermission(
    [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
    { type: 'or' }
  );

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
            revalidateList();
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
          revalidateList();
        }}
      />
      <div
        className="relative flex w-full flex-col justify-between overflow-hidden rounded-xl bg-gray-800 py-2 text-gray-400 shadow-md ring-1 ring-gray-700 xl:h-28 xl:flex-row"
        ref={ref}
      >
        <div className="relative flex w-full flex-col justify-between overflow-hidden sm:flex-row">
          <div className="relative z-10 flex w-full items-center overflow-hidden pl-4 pr-4 sm:pr-0 xl:w-7/12 2xl:w-2/3">
            <Link
              href={href}
              className="relative w-12 flex-shrink-0 overflow-hidden rounded-md"
              tabIndex={-1}
              aria-hidden
            >
              <div
                className="relative w-full"
                style={{ paddingBottom: '100%' }}
              >
                <NearScreen.Provider value={nearness}>
                  <MusicImage
                    src={musicRequestImage(requestData)}
                    fallback={
                      requestData.albums?.length === 1 ? 'album' : 'artist'
                    }
                    sizes="3rem"
                  />
                </NearScreen.Provider>
              </div>
            </Link>
            <div className="flex flex-col justify-center overflow-hidden pl-2 xl:pl-4">
              <div className="pt-0.5 text-xs font-medium text-strong sm:pt-1">
                {intl.formatMessage(globalMessages.music)}
              </div>
              <Link
                href={href}
                className="mr-2 min-w-0 truncate text-lg font-bold text-strong hover:underline xl:text-xl"
              >
                {title}
              </Link>
              <AlbumsField request={requestData} />
            </div>
          </div>
          <div className="z-10 ml-4 mt-4 flex w-full flex-col justify-center gap-1 overflow-hidden pr-4 text-sm sm:ml-2 sm:mt-0 xl:flex-1 xl:pr-0">
            <div className="card-field">
              <span className="card-field-name">
                {intl.formatMessage(globalMessages.status)}
              </span>
              <MusicRequestBadge request={requestData} />
            </div>
            {requestData.status === MediaRequestStatus.DECLINED &&
              requestData.declineReason && (
                <DeclineReason
                  reason={requestData.declineReason}
                  className="py-0.5 sm:py-1"
                />
              )}
            <div className="card-field">
              <span className="card-field-name">
                {intl.formatMessage(messages.requested)}
              </span>
              <span className="flex truncate text-sm text-gray-300">
                {seesOthers && requestData.requestedBy
                  ? intl.formatMessage(messages.modifieduserdate, {
                      date: since(requestData.createdAt),
                      user: <Person person={requestData.requestedBy} />,
                    })
                  : since(requestData.createdAt)}
              </span>
            </div>
            {requestData.modifiedBy && (
              <div className="card-field">
                <span className="card-field-name">
                  {intl.formatMessage(messages.modified)}
                </span>
                <span className="flex truncate text-sm text-gray-300">
                  {intl.formatMessage(messages.modifieduserdate, {
                    date: since(requestData.updatedAt),
                    user: <Person person={requestData.modifiedBy} />,
                  })}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="z-10 mt-4 flex w-full flex-col justify-center space-y-2 pl-4 pr-4 xl:mt-0 xl:w-96 xl:items-end xl:pl-0">
          {requestData.status === MediaRequestStatus.FAILED && manages && (
            <Button
              className="w-full"
              buttonType="primary"
              disabled={isRetrying}
              onClick={() => retry()}
            >
              <ArrowPathIcon
                className={isRetrying ? 'animate-spin' : ''}
                style={{ animationDirection: 'reverse' }}
              />
              <span>
                {intl.formatMessage(
                  isRetrying ? globalMessages.retrying : globalMessages.retry
                )}
              </span>
            </Button>
          )}
          {!pending && manages && (
            <ConfirmButton
              onClick={async () => {
                await remove();
                revalidateList();
              }}
              confirmText={intl.formatMessage(globalMessages.areyousure)}
              className="w-full"
            >
              <TrashIcon />
              <span>{intl.formatMessage(messages.deleterequest)}</span>
            </ConfirmButton>
          )}
          {pending && manages && (
            <div className="flex w-full flex-row space-x-2">
              <span className="w-full">
                <Button
                  className="w-full"
                  buttonType="success"
                  onClick={async () => {
                    await approve();
                    revalidateList();
                  }}
                  disabled={isApproving}
                >
                  {isApproving ? <Spinner /> : <CheckIcon />}
                  <span>{intl.formatMessage(globalMessages.approve)}</span>
                </Button>
              </span>
              <span className="w-full">
                <Button
                  className="w-full"
                  buttonType="danger"
                  onClick={() => setShowDeclineModal(true)}
                  disabled={isApproving}
                >
                  <XMarkIcon />
                  <span>{intl.formatMessage(globalMessages.decline)}</span>
                </Button>
              </span>
            </div>
          )}
          {pending && (manages || isOwner) && (
            <span className="w-full">
              <Button
                className="w-full"
                buttonType="primary"
                onClick={() => setShowEditModal(true)}
                disabled={isApproving}
              >
                <PencilIcon />
                <span>{intl.formatMessage(messages.editrequest)}</span>
              </Button>
            </span>
          )}
          {pending && !manages && isOwner && (
            <ConfirmButton
              onClick={async () => {
                await remove();
                revalidateList();
              }}
              confirmText={intl.formatMessage(globalMessages.areyousure)}
              className="w-full"
            >
              <XMarkIcon />
              <span>{intl.formatMessage(messages.cancelRequest)}</span>
            </ConfirmButton>
          )}
        </div>
      </div>
    </>
  );
};

export default MusicRequestItem;
