import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import Tooltip from '@app/components/Common/Tooltip';
import DeclineReason from '@app/components/DeclineReason';
import DeclineRequestModal from '@app/components/DeclineRequestModal';
import { songName } from '@app/components/Music/musicHelpers';
import RequestModal from '@app/components/RequestModal';
import RequestServerIssue from '@app/components/RequestServerIssue';
import useRequestAction from '@app/hooks/useRequestAction';
import useRequestOverride from '@app/hooks/useRequestOverride';
import useRetryRequest from '@app/hooks/useRetryRequest';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  CalendarIcon,
  CheckIcon,
  EyeIcon,
  PencilIcon,
  TrashIcon,
  UserIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import type { VideoMediaType } from '@server/constants/media';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import { mutate } from 'swr';

const messages = defineMessages('components.RequestBlock', {
  seasons: '{seasonCount, plural, one {Season} other {Seasons}}',
  albums: '{albumCount, plural, one {Album} other {Albums}}',
  songs: '{songCount, plural, one {Song} other {Songs}}',
  requestoverrides: 'Request Overrides',
  server: 'Destination Server',
  profilechanged: 'Quality Profile',
  rootfolder: 'Root Folder',
  languageprofile: 'Language Profile',
  requestdate: 'Request Date',
  requestedby: 'Requested By',
  lastmodifiedby: 'Last Modified By',
  approve: 'Approve Request',
  decline: 'Decline Request',
  edit: 'Edit Request',
  delete: 'Delete Request',
});

interface RequestBlockProps {
  request: MediaRequest;
  onUpdate?: () => void;
}

const RequestBlock = ({ request, onUpdate }: RequestBlockProps) => {
  const { user, hasPermission } = useUser();
  const intl = useIntl();
  const { run, isBusy: isUpdating } = useRequestAction();
  const { retry, isRetrying } = useRetryRequest(
    request,
    () => {
      onUpdate?.();
      mutate('/api/v1/request/count');
    },
    globalMessages.error
  );
  const failedForManager =
    request.status === MediaRequestStatus.FAILED &&
    hasPermission(Permission.MANAGE_REQUESTS);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const { profile, rootFolder, server, languageProfile } =
    useRequestOverride(request);

  const approveRequest = () =>
    run(async () => {
      await axios.post(`/api/v1/request/${request.id}/approve`);

      if (onUpdate) {
        onUpdate();
        mutate('/api/v1/request/count');
      }
    });

  const deleteRequest = () =>
    run(async () => {
      await axios.delete(`/api/v1/request/${request.id}`);

      if (onUpdate) {
        onUpdate();
        mutate('/api/v1/request/count');
      }
    });

  return (
    <div className="block">
      {request.type === MediaType.MUSIC ? (
        <RequestModal
          show={showEditModal}
          type="music"
          artistMbid={request.media.foreignId ?? ''}
          editRequest={request}
          onCancel={() => setShowEditModal(false)}
          onComplete={() => {
            onUpdate?.();
            setShowEditModal(false);
          }}
        />
      ) : (
        <RequestModal
          show={showEditModal}
          tmdbId={request.media.tmdbId}
          type={request.type as VideoMediaType}
          is4k={request.is4k}
          editRequest={request}
          onCancel={() => setShowEditModal(false)}
          onComplete={() => {
            if (onUpdate) {
              onUpdate();
            }
            setShowEditModal(false);
          }}
        />
      )}
      <DeclineRequestModal
        show={showDeclineModal}
        requests={[request]}
        onCancel={() => setShowDeclineModal(false)}
        onComplete={() => {
          setShowDeclineModal(false);
          onUpdate?.();
        }}
      />
      <div className="px-4 py-3 text-gray-300">
        <div className="flex items-center justify-between">
          <div className="mr-6 min-w-0 flex-1 flex-col items-center text-sm leading-5">
            <div className="white mb-1 flex flex-nowrap">
              <span className="flex min-w-0 items-center">
                <Tooltip content={intl.formatMessage(messages.requestedby)}>
                  <UserIcon className="mr-1.5 h-5 w-5 min-w-0 flex-shrink-0" />
                </Tooltip>
                <Link
                  href={
                    request.requestedBy.id === user?.id
                      ? '/profile'
                      : `/users/${request.requestedBy.id}`
                  }
                  className="flex min-w-0 items-center font-semibold text-gray-100 transition duration-300 [overflow-wrap:anywhere] hover:text-strong hover:underline"
                >
                  <span className="avatar-sm">
                    <CachedImage
                      type="avatar"
                      src={request.requestedBy.avatar}
                      alt=""
                      className="avatar-sm object-cover"
                      width={20}
                      height={20}
                    />
                  </span>
                  {request.requestedBy.displayName}
                </Link>
              </span>
            </div>
            {request.modifiedBy && (
              <div className="flex flex-nowrap">
                <span className="flex min-w-0 items-center">
                  <Tooltip
                    content={intl.formatMessage(messages.lastmodifiedby)}
                  >
                    <EyeIcon className="mr-1.5 h-5 w-5 flex-shrink-0" />
                  </Tooltip>
                  <Link
                    href={
                      request.modifiedBy.id === user?.id
                        ? '/profile'
                        : `/users/${request.modifiedBy.id}`
                    }
                    className="flex min-w-0 items-center font-semibold text-gray-100 transition duration-300 [overflow-wrap:anywhere] hover:text-strong hover:underline"
                  >
                    <span className="avatar-sm">
                      <CachedImage
                        type="avatar"
                        src={request.modifiedBy.avatar}
                        alt=""
                        className="avatar-sm object-cover"
                        width={20}
                        height={20}
                      />
                    </span>
                    {request.modifiedBy.displayName}
                  </Link>
                </span>
              </div>
            )}
          </div>
          <div className="ml-2 flex flex-shrink-0 flex-wrap">
            {request.status === MediaRequestStatus.PENDING && (
              <>
                <Tooltip content={intl.formatMessage(messages.approve)}>
                  <Button
                    buttonType="success"
                    className="mr-1"
                    onClick={() => approveRequest()}
                    disabled={isUpdating}
                  >
                    <CheckIcon className="icon-sm" />
                  </Button>
                </Tooltip>
                <Tooltip content={intl.formatMessage(messages.decline)}>
                  <Button
                    buttonType="danger"
                    className="mr-1"
                    onClick={() => setShowDeclineModal(true)}
                    disabled={isUpdating}
                  >
                    <XMarkIcon />
                  </Button>
                </Tooltip>
                <Tooltip content={intl.formatMessage(messages.edit)}>
                  <Button
                    buttonType="warning"
                    onClick={() => setShowEditModal(true)}
                    disabled={isUpdating}
                  >
                    <PencilIcon className="icon-sm" />
                  </Button>
                </Tooltip>
              </>
            )}
            {failedForManager && (
              <>
                <Tooltip content={intl.formatMessage(globalMessages.retry)}>
                  <Button
                    buttonType="primary"
                    className="mr-1"
                    onClick={() => retry()}
                    disabled={isUpdating || isRetrying}
                  >
                    <ArrowPathIcon
                      className={`icon-sm ${isRetrying ? 'animate-spin' : ''}`}
                      style={{ animationDirection: 'reverse' }}
                    />
                  </Button>
                </Tooltip>
                {/* Another server, profile or folder, before retrying. */}
                <Tooltip content={intl.formatMessage(messages.edit)}>
                  <Button
                    buttonType="warning"
                    className="mr-1"
                    onClick={() => setShowEditModal(true)}
                    disabled={isUpdating || isRetrying}
                  >
                    <PencilIcon className="icon-sm" />
                  </Button>
                </Tooltip>
              </>
            )}
            {request.status !== MediaRequestStatus.PENDING && (
              <Tooltip content={intl.formatMessage(messages.delete)}>
                <Button
                  buttonType="danger"
                  onClick={() => deleteRequest()}
                  disabled={isUpdating || isRetrying}
                >
                  <TrashIcon className="icon-sm" />
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
        <div className="mt-2 sm:flex sm:justify-between">
          <div className="sm:flex">
            <div className="mr-6 flex items-center text-sm leading-5">
              {request.is4k && (
                <span className="mr-1">
                  <Badge badgeType="warning">4K</Badge>
                </span>
              )}
              {request.status === MediaRequestStatus.APPROVED && (
                <Badge badgeType="success">
                  {intl.formatMessage(globalMessages.approved)}
                </Badge>
              )}
              {request.status === MediaRequestStatus.DECLINED && (
                <Badge badgeType="danger">
                  {intl.formatMessage(globalMessages.declined)}
                </Badge>
              )}
              {request.status === MediaRequestStatus.PENDING && (
                <Badge badgeType="warning">
                  {intl.formatMessage(globalMessages.pending)}
                </Badge>
              )}
              {request.status === MediaRequestStatus.FAILED && (
                <Badge badgeType="danger">
                  {intl.formatMessage(globalMessages.failed)}
                </Badge>
              )}
              {request.status === MediaRequestStatus.COMPLETED && (
                <Badge badgeType="success">
                  {intl.formatMessage(globalMessages.completed)}
                </Badge>
              )}
            </div>
          </div>
          <div className="mt-2 flex items-center text-sm leading-5 sm:mt-0">
            <Tooltip content={intl.formatMessage(messages.requestdate)}>
              <CalendarIcon className="mr-1.5 h-5 w-5 flex-shrink-0" />
            </Tooltip>
            <Tooltip
              content={intl.formatDate(request.createdAt, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                second: 'numeric',
              })}
            >
              <span>
                {intl.formatDate(request.createdAt, {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </span>
            </Tooltip>
          </div>
        </div>
        {request.status === MediaRequestStatus.DECLINED &&
          request.declineReason && (
            <DeclineReason
              reason={request.declineReason}
              whole
              className="mt-2"
            />
          )}
        <RequestServerIssue request={request} className="mt-2" />
        {(request.seasons ?? []).length > 0 && (
          <div className="mt-2 flex flex-col text-sm">
            <div className="mb-1 font-medium">
              {intl.formatMessage(messages.seasons, {
                seasonCount: request.seasons.length,
              })}
            </div>
            <div>
              {request.seasons.map((season) => (
                <span
                  key={`season-${season.id}`}
                  className="mb-1 mr-2 inline-block"
                >
                  <Badge>
                    {season.seasonNumber === 0
                      ? intl.formatMessage(globalMessages.specials)
                      : season.seasonNumber}
                  </Badge>
                </span>
              ))}
            </div>
          </div>
        )}
        {(request.albums ?? []).length > 0 && (
          <div className="mt-2 flex flex-col text-sm">
            <div className="mb-1 font-medium">
              {intl.formatMessage(messages.albums, {
                albumCount: request.albums.length,
              })}
            </div>
            <div>
              {[...request.albums]
                .sort((a, b) => a.id - b.id)
                .map((album) => (
                  <span
                    key={`album-${album.id}`}
                    className="mb-1 mr-2 inline-block"
                  >
                    <Badge>{album.title}</Badge>
                  </span>
                ))}
            </div>
          </div>
        )}
        {(request.songs ?? []).length > 0 && (
          <div className="mt-2 flex flex-col text-sm">
            <div className="mb-1 font-medium">
              {intl.formatMessage(messages.songs, {
                songCount: request.songs.length,
              })}
            </div>
            <div>
              {[...request.songs]
                .sort((a, b) => a.id - b.id)
                .map((song) => (
                  <span
                    key={`song-${song.id}`}
                    className="mb-1 mr-2 inline-block"
                  >
                    <Badge>{songName(song.title, song.version)}</Badge>
                  </span>
                ))}
            </div>
          </div>
        )}
        {(server || profile || rootFolder || languageProfile) && (
          <>
            <div className="mb-1 mt-4 text-sm">
              {intl.formatMessage(messages.requestoverrides)}
            </div>
            <ul className="divide-y divide-gray-700 rounded-md bg-gray-800 px-2 text-xs">
              {server && (
                <li className="flex justify-between px-1 py-2">
                  <span className="font-bold">
                    {intl.formatMessage(messages.server)}
                  </span>
                  <span>{server}</span>
                </li>
              )}
              {profile && (
                <li className="flex justify-between px-1 py-2">
                  <span className="font-bold">
                    {intl.formatMessage(messages.profilechanged)}
                  </span>
                  <span>{profile}</span>
                </li>
              )}
              {rootFolder && (
                <li className="flex justify-between px-1 py-2">
                  <span className="mr-2 font-bold">
                    {intl.formatMessage(messages.rootfolder)}
                  </span>
                  <span>{rootFolder}</span>
                </li>
              )}
              {languageProfile && (
                <li className="flex justify-between px-1 py-2">
                  <span className="mr-2 font-bold">
                    {intl.formatMessage(messages.languageprofile)}
                  </span>
                  <span>{languageProfile}</span>
                </li>
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
};

export default RequestBlock;
