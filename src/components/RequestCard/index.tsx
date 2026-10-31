import Spinner from '@app/assets/spinner.svg';
import { AiSearchingBadge } from '@app/components/Backfill/shared';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import Tooltip from '@app/components/Common/Tooltip';
import DeclineReason from '@app/components/DeclineReason';
import DeclineRequestModal from '@app/components/DeclineRequestModal';
import MusicRequestCard from '@app/components/Music/MusicRequest/MusicRequestCard';
import RequestModal from '@app/components/RequestModal';
import RequestServerIssue from '@app/components/RequestServerIssue';
import StatusBadge from '@app/components/StatusBadge';
import useNearScreen, {
  bothRefs,
  useLoadWhenNear,
} from '@app/hooks/useNearScreen';
import usePlayLinks from '@app/hooks/usePlayLinks';
import useRequestAction from '@app/hooks/useRequestAction';
import useRetryRequest from '@app/hooks/useRetryRequest';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { pictureLoading } from '@app/utils/nearScreen';
import {
  getRequestDownloadStatus,
  refreshIntervalHelper,
  watchRequest,
} from '@app/utils/refreshIntervalHelper';
import { withProperties } from '@app/utils/typeHelpers';
import {
  ArrowPathIcon,
  CheckIcon,
  PencilIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import type { VideoMediaType } from '@server/constants/media';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { BackfillStatus } from '@server/interfaces/api/backfillStatus';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.RequestCard', {
  seasons: '{seasonCount, plural, one {Season} other {Seasons}}',
  failedretry: 'Something went wrong while retrying the request.',
  failedmodify: 'Something went wrong while modifying the request.',
  mediaerror: '{mediaType} Not Found',
  tmdbid: 'TMDB ID',
  tvdbid: 'TheTVDB ID',
  approverequest: 'Approve Request',
  declinerequest: 'Decline Request',
  editrequest: 'Edit Request',
  cancelrequest: 'Cancel Request',
  deleterequest: 'Delete Request',
  unknowntitle: 'Unknown Title',
});

const isMovie = (movie: MovieDetails | TvDetails): movie is MovieDetails => {
  return (movie as MovieDetails).title !== undefined;
};

const RequestCardPlaceholder = () => {
  return (
    <div className="relative w-72 animate-pulse rounded-xl bg-gray-700 p-4 sm:w-96">
      <div className="w-20 sm:w-28">
        <div className="w-full" style={{ paddingBottom: '150%' }} />
      </div>
    </div>
  );
};

interface RequestCardErrorProps {
  requestData?: NonFunctionProperties<MediaRequest>;
}

const RequestCardError = ({ requestData }: RequestCardErrorProps) => {
  const { hasPermission } = useUser();
  const intl = useIntl();

  const { playLink, playLink4k } = usePlayLinks(requestData?.media);

  const requestDownloadStatus = getRequestDownloadStatus(
    requestData?.media?.[
      requestData?.is4k ? 'downloadStatus4k' : 'downloadStatus'
    ],
    requestData?.type === 'tv'
      ? (requestData?.seasons ?? []).map((season) => season.seasonNumber)
      : []
  );

  const { run } = useRequestAction();
  const deleteRequest = () =>
    run(async () => {
      await axios.delete(`/api/v1/media/${requestData?.media.id}`);
      mutate('/api/v1/media?filter=allavailable&take=20&sort=mediaAdded');
      mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
      mutate('/api/v1/request/count');
    }, messages.failedmodify);

  return (
    <div
      className="relative flex w-72 overflow-hidden rounded-xl bg-surface p-4 text-muted shadow ring-1 ring-red-500 sm:w-96"
      data-testid="request-card"
    >
      <div className="w-20 sm:w-28">
        <div className="w-full" style={{ paddingBottom: '150%' }}>
          <div className="absolute inset-0 z-10 flex min-w-0 flex-1 flex-col p-4">
            <div
              className="whitespace-normal text-base font-bold text-strong sm:text-lg"
              data-testid="request-card-title"
            >
              {intl.formatMessage(messages.mediaerror, {
                mediaType: intl.formatMessage(
                  requestData?.type
                    ? requestData?.type === 'movie'
                      ? globalMessages.movie
                      : globalMessages.tvshow
                    : globalMessages.request
                ),
              })}
            </div>
            {requestData && (
              <>
                {hasPermission(
                  [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
                  { type: 'or' }
                ) && (
                  <div className="card-field !hidden truncate sm:!block">
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
                      <span className="truncate group-hover:underline">
                        {requestData.requestedBy.displayName}
                      </span>
                    </Link>
                  </div>
                )}
                <div className="mt-2 flex items-center text-sm sm:mt-1">
                  <span className="mr-2 hidden font-bold sm:block">
                    {intl.formatMessage(globalMessages.status)}
                  </span>
                  {requestData.status === MediaRequestStatus.DECLINED ||
                  requestData.status === MediaRequestStatus.FAILED ? (
                    <Badge badgeType="danger">
                      {requestData.status === MediaRequestStatus.DECLINED
                        ? intl.formatMessage(globalMessages.declined)
                        : intl.formatMessage(globalMessages.failed)}
                    </Badge>
                  ) : (
                    <StatusBadge
                      status={
                        requestData.media[
                          requestData.is4k ? 'status4k' : 'status'
                        ]
                      }
                      downloadItem={requestDownloadStatus}
                      title={intl.formatMessage(messages.unknowntitle)}
                      inProgress={requestDownloadStatus.length > 0}
                      is4k={requestData.is4k}
                      mediaType={requestData.type as VideoMediaType}
                      playLink={requestData.is4k ? playLink4k : playLink}
                      serviceUrl={
                        requestData.is4k
                          ? requestData.media.serviceUrl4k
                          : requestData.media.serviceUrl
                      }
                    />
                  )}
                </div>
                <RequestServerIssue
                  request={requestData}
                  compact
                  className="mt-1"
                />
              </>
            )}
            <div className="flex flex-1 items-end space-x-2">
              {hasPermission(Permission.MANAGE_REQUESTS) &&
                requestData?.media.id && (
                  <>
                    <Button
                      buttonType="danger"
                      buttonSize="sm"
                      className="mt-4 hidden sm:block"
                      onClick={() => deleteRequest()}
                    >
                      <TrashIcon />
                      <span>{intl.formatMessage(globalMessages.delete)}</span>
                    </Button>
                    <Tooltip
                      content={intl.formatMessage(messages.deleterequest)}
                    >
                      <Button
                        buttonType="danger"
                        buttonSize="sm"
                        className="mt-4 sm:hidden"
                        onClick={() => deleteRequest()}
                      >
                        <TrashIcon />
                      </Button>
                    </Tooltip>
                  </>
                )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

interface RequestCardProps {
  request: NonFunctionProperties<MediaRequest>;
  onTitleData?: (requestId: number, title: MovieDetails | TvDetails) => void;
}

const RequestCard = ({ request, onTitleData }: RequestCardProps) => {
  // Near the screen, for loading the title (and its pictures) before the
  // card is scrolled to; on screen now, for checking on the request.
  const { ref: nearRef, near, nearness } = useNearScreen();
  const { ref: viewRef, inView } = useInView();
  const ref = useMemo(() => bothRefs(nearRef, viewRef), [nearRef, viewRef]);
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const { addToast } = useToasts();
  const [isApproving, setIsApproving] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const url =
    request.type === 'movie'
      ? `/api/v1/movie/${request.media.tmdbId}`
      : `/api/v1/tv/${request.media.tmdbId}`;

  const titleKey = useLoadWhenNear(url, near);
  const { data: title, error } = useSWR<MovieDetails | TvDetails>(titleKey);
  const {
    data: requestData,
    error: requestError,
    mutate: revalidate,
  } = useSWR<NonFunctionProperties<MediaRequest>>(
    `/api/v1/request/${request.id}`,
    {
      fallbackData: request,
      // Only while it can be seen: a card scrolled out of the row is not
      // asked about again until it comes back into view.
      refreshInterval: inView
        ? refreshIntervalHelper<NonFunctionProperties<MediaRequest>>(
            watchRequest,
            request
          )
        : 0,
    }
  );

  const { playLink, playLink4k } = usePlayLinks(requestData?.media);

  // Whether the admin agent (an AI) is looking for it: only while the card
  // can be seen and the request is approved and not yet all here.
  const shown = requestData ?? request;
  const mayBeLooked =
    inView &&
    shown.status === MediaRequestStatus.APPROVED &&
    shown.media[shown.is4k ? 'status4k' : 'status'] !== MediaStatus.AVAILABLE;
  const { data: backfillStatus } = useSWR<BackfillStatus[]>(
    mayBeLooked
      ? `/api/v1/backfill-status?tmdbIds=${shown.media.tmdbId}`
      : null,
    {
      refreshInterval: (latest) =>
        latest?.some((s) => s.agent || s.state === 'downloading') ? 15000 : 0,
    }
  );
  const aiSearching = !!backfillStatus?.some(
    (s) => s.agent && s.mediaType === shown.type
  );

  const approveRequest = async () => {
    setIsApproving(true);
    try {
      await axios.post(`/api/v1/request/${request.id}/approve`);
      revalidate();
      mutate('/api/v1/request/count');
    } catch {
      addToast(intl.formatMessage(messages.failedmodify), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setIsApproving(false);
    }
  };

  const { run } = useRequestAction();
  const deleteRequest = () =>
    run(async () => {
      await axios.delete(`/api/v1/request/${request.id}`);
      mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
      mutate('/api/v1/request/count');
    }, messages.failedmodify);

  const { retry: retryRequest, isRetrying } = useRetryRequest(
    request,
    revalidate,
    messages.failedretry
  );

  useEffect(() => {
    if (title && onTitleData) {
      onTitleData(request.id, title);
    }
  }, [title, onTitleData, request]);

  if (!title && !error) {
    return (
      <div ref={ref}>
        <RequestCardPlaceholder />
      </div>
    );
  }

  if (!requestData && !requestError) {
    return <RequestCardError />;
  }

  if (!title || !requestData) {
    return <RequestCardError requestData={requestData} />;
  }

  const requestDownloadStatus = getRequestDownloadStatus(
    requestData.media[requestData.is4k ? 'downloadStatus4k' : 'downloadStatus'],
    requestData.type === 'tv'
      ? requestData.seasons.map((season) => season.seasonNumber)
      : []
  );

  return (
    <>
      <RequestModal
        show={showEditModal}
        tmdbId={request.media.tmdbId}
        // The requests listed here are for films and series.
        type={request.type as VideoMediaType}
        is4k={request.is4k}
        // As it is now: it may have failed since the list was loaded.
        editRequest={requestData}
        onCancel={() => setShowEditModal(false)}
        onComplete={() => {
          revalidate();
          setShowEditModal(false);
        }}
      />
      <DeclineRequestModal
        show={showDeclineModal}
        requests={[request]}
        subTitle={isMovie(title) ? title.title : title.name}
        onCancel={() => setShowDeclineModal(false)}
        onComplete={() => {
          setShowDeclineModal(false);
          revalidate();
        }}
      />
      <div
        className="relative flex w-72 overflow-hidden rounded-xl bg-surface bg-cover bg-center p-4 text-muted shadow ring-1 ring-subtle sm:w-96"
        data-testid="request-card"
        data-seerr="request-card"
        ref={ref}
      >
        {title.backdropPath && (
          <div className="absolute inset-0 z-0">
            <CachedImage
              type="tmdb"
              alt=""
              src={`https://image.tmdb.org/t/p/w1000_and_h450_multi_faces/${title.backdropPath}`}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              fill
              // The card is 18rem wide, 24rem from sm: a small backdrop does.
              sizes="(min-width: 640px) 384px, 288px"
              {...pictureLoading(nearness)}
            />
            <div
              className="absolute inset-0"
              style={{
                backgroundImage:
                  'linear-gradient(135deg, rgb(var(--page) / var(--title-fade)) 0%, rgb(var(--page)) 75%)',
              }}
            />
          </div>
        )}
        <div
          className="relative z-10 flex min-w-0 flex-1 flex-col pr-4"
          data-testid="request-card-title"
        >
          {/* The year on a phone too, as a music card has its artist. */}
          <div className="flex text-xs font-medium text-strong">
            {(isMovie(title) ? title.releaseDate : title.firstAirDate)?.slice(
              0,
              4
            )}
          </div>
          <Link
            href={
              request.type === 'movie'
                ? `/movie/${requestData.media.tmdbId}`
                : `/tv/${requestData.media.tmdbId}`
            }
            title={isMovie(title) ? title.title : title.name}
            // A long name takes a second line rather than being cut short.
            className="line-clamp-2 whitespace-normal break-words text-base font-bold leading-tight text-strong hover:underline sm:text-lg sm:leading-snug"
          >
            {isMovie(title) ? title.title : title.name}
          </Link>
          {hasPermission(
            [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
            { type: 'or' }
          ) && (
            <div className="card-field truncate">
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
          {!isMovie(title) && request.seasons.length > 0 && (
            <div className="my-0.5 hidden items-center text-sm sm:my-1 sm:flex">
              <span className="mr-2 font-bold">
                {intl.formatMessage(messages.seasons, {
                  seasonCount: request.seasons.length,
                })}
              </span>
              <div className="hide-scrollbar overflow-x-scroll">
                {request.seasons.map((season) => (
                  <span key={`season-${season.id}`} className="mr-2">
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
          <div className="mt-2 flex min-w-0 items-center text-sm sm:mt-1">
            <span className="mr-2 hidden flex-none font-bold sm:block">
              {intl.formatMessage(globalMessages.status)}
            </span>
            {/* While the admin agent looks for it, that is what's
                happening, in place of the request's own status. */}
            {aiSearching ? (
              <AiSearchingBadge className="flex-none" />
            ) : requestData.status === MediaRequestStatus.DECLINED ? (
              <Badge badgeType="danger">
                {intl.formatMessage(globalMessages.declined)}
              </Badge>
            ) : requestData.status === MediaRequestStatus.FAILED ? (
              <Badge
                badgeType="danger"
                href={`/${requestData.type}/${requestData.media.tmdbId}?manage=1`}
              >
                {intl.formatMessage(globalMessages.failed)}
              </Badge>
            ) : requestData.status === MediaRequestStatus.PENDING &&
              requestData.media[requestData.is4k ? 'status4k' : 'status'] ===
                MediaStatus.DELETED ? (
              <Badge
                badgeType="warning"
                href={`/${requestData.type}/${requestData.media.tmdbId}?manage=1`}
              >
                {intl.formatMessage(globalMessages.pending)}
              </Badge>
            ) : (
              <StatusBadge
                status={
                  requestData.media[requestData.is4k ? 'status4k' : 'status']
                }
                downloadItem={requestDownloadStatus}
                title={isMovie(title) ? title.title : title.name}
                inProgress={requestDownloadStatus.length > 0}
                is4k={requestData.is4k}
                tmdbId={requestData.media.tmdbId}
                mediaType={requestData.type as VideoMediaType}
                playLink={requestData.is4k ? playLink4k : playLink}
                serviceUrl={
                  requestData.is4k
                    ? requestData.media.serviceUrl4k
                    : requestData.media.serviceUrl
                }
              />
            )}
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
            {requestData.status === MediaRequestStatus.FAILED &&
              hasPermission(Permission.MANAGE_REQUESTS) && (
                <>
                  <Tooltip content={intl.formatMessage(globalMessages.retry)}>
                    <Button
                      buttonType="primary"
                      buttonSize="sm"
                      disabled={isRetrying}
                      onClick={() => retryRequest()}
                      // Its label is hidden on a phone.
                      aria-label={intl.formatMessage(globalMessages.retry)}
                    >
                      <ArrowPathIcon
                        className={isRetrying ? 'animate-spin' : ''}
                        style={{
                          marginRight: '0',
                          animationDirection: 'reverse',
                        }}
                      />
                      <span className="ml-1.5 hidden sm:block">
                        {intl.formatMessage(globalMessages.retry)}
                      </span>
                    </Button>
                  </Tooltip>
                  {/* Another server, profile or folder, before retrying. */}
                  <Tooltip content={intl.formatMessage(messages.editrequest)}>
                    <Button
                      buttonType="default"
                      buttonSize="sm"
                      disabled={isRetrying}
                      onClick={() => setShowEditModal(true)}
                      aria-label={intl.formatMessage(messages.editrequest)}
                    >
                      <PencilIcon style={{ marginRight: '0' }} />
                      <span className="ml-1.5 hidden sm:block">
                        {intl.formatMessage(globalMessages.edit)}
                      </span>
                    </Button>
                  </Tooltip>
                </>
              )}
            {requestData.status === MediaRequestStatus.PENDING &&
              hasPermission(Permission.MANAGE_REQUESTS) && (
                <>
                  <div>
                    <Button
                      buttonType="success"
                      buttonSize="sm"
                      className="hidden sm:block"
                      onClick={() => approveRequest()}
                      disabled={isApproving}
                    >
                      {isApproving ? <Spinner /> : <CheckIcon />}
                      <span>{intl.formatMessage(globalMessages.approve)}</span>
                    </Button>
                    <Tooltip
                      content={intl.formatMessage(messages.approverequest)}
                    >
                      <Button
                        buttonType="success"
                        buttonSize="sm"
                        className="sm:hidden"
                        onClick={() => approveRequest()}
                        disabled={isApproving}
                      >
                        {isApproving ? <Spinner /> : <CheckIcon />}
                      </Button>
                    </Tooltip>
                  </div>
                  <div>
                    <Button
                      buttonType="danger"
                      buttonSize="sm"
                      className="hidden sm:block"
                      onClick={() => setShowDeclineModal(true)}
                      disabled={isApproving}
                    >
                      <XMarkIcon />
                      <span>{intl.formatMessage(globalMessages.decline)}</span>
                    </Button>
                    <Tooltip
                      content={intl.formatMessage(messages.declinerequest)}
                    >
                      <Button
                        buttonType="danger"
                        buttonSize="sm"
                        className="sm:hidden"
                        onClick={() => setShowDeclineModal(true)}
                        disabled={isApproving}
                      >
                        <XMarkIcon />
                      </Button>
                    </Tooltip>
                  </div>
                </>
              )}
            {requestData.status === MediaRequestStatus.PENDING &&
              !hasPermission(Permission.MANAGE_REQUESTS) &&
              requestData.requestedBy.id === user?.id &&
              (requestData.type === 'tv' ||
                hasPermission(Permission.REQUEST_ADVANCED)) && (
                <div>
                  {!hasPermission(Permission.MANAGE_REQUESTS) && (
                    <Button
                      buttonType="primary"
                      buttonSize="sm"
                      className="hidden sm:block"
                      onClick={() => setShowEditModal(true)}
                      disabled={isApproving}
                    >
                      <PencilIcon />
                      <span>{intl.formatMessage(globalMessages.edit)}</span>
                    </Button>
                  )}
                  <Tooltip content={intl.formatMessage(messages.editrequest)}>
                    <Button
                      buttonType="primary"
                      buttonSize="sm"
                      className="sm:hidden"
                      onClick={() => setShowEditModal(true)}
                      disabled={isApproving}
                    >
                      <PencilIcon />
                    </Button>
                  </Tooltip>
                </div>
              )}
            {requestData.status === MediaRequestStatus.PENDING &&
              !hasPermission(Permission.MANAGE_REQUESTS) &&
              requestData.requestedBy.id === user?.id && (
                <div>
                  <Button
                    buttonType="danger"
                    buttonSize="sm"
                    className="hidden sm:block"
                    onClick={() => deleteRequest()}
                  >
                    <XMarkIcon />
                    <span>{intl.formatMessage(globalMessages.cancel)}</span>
                  </Button>
                  <Tooltip content={intl.formatMessage(messages.cancelrequest)}>
                    <Button
                      buttonType="danger"
                      buttonSize="sm"
                      className="sm:hidden"
                      onClick={() => deleteRequest()}
                    >
                      <XMarkIcon />
                    </Button>
                  </Tooltip>
                </div>
              )}
          </div>
        </div>
        <Link
          href={
            request.type === 'movie'
              ? `/movie/${requestData.media.tmdbId}`
              : `/tv/${requestData.media.tmdbId}`
          }
          className="w-20 flex-shrink-0 scale-100 transform-gpu cursor-pointer overflow-hidden rounded-md shadow-sm transition duration-300 hover:scale-105 hover:shadow-md sm:w-28"
          // The title on the card is the same link.
          tabIndex={-1}
          aria-hidden
        >
          <CachedImage
            type="tmdb"
            src={
              title.posterPath
                ? `https://image.tmdb.org/t/p/w300_and_h450_face${title.posterPath}`
                : '/images/seerr_poster_not_found.png'
            }
            alt=""
            sizes="100vw"
            style={{ width: '100%', height: 'auto' }}
            width={300}
            height={450}
            {...pictureLoading(nearness)}
          />
        </Link>
      </div>
    </>
  );
};

/** Music has a card of its own: it has no TMDB title to look up. */
const RequestCardFor = (props: RequestCardProps) =>
  props.request.type === MediaType.MUSIC ? (
    <MusicRequestCard request={props.request} />
  ) : (
    <RequestCard {...props} />
  );

export default withProperties(RequestCardFor, {
  Placeholder: RequestCardPlaceholder,
});
