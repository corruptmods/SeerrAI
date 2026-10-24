import Alert from '@app/components/Common/Alert';
import Modal from '@app/components/Common/Modal';
import type { RequestOverrides } from '@app/components/RequestModal/AdvancedRequester';
import AdvancedRequester from '@app/components/RequestModal/AdvancedRequester';
import AnimeChoice, {
  useAnimeChoice,
} from '@app/components/RequestModal/AnimeChoice';
import FailedRequestAlert, {
  failedMessages,
} from '@app/components/RequestModal/FailedRequestAlert';
import QuotaDisplay from '@app/components/RequestModal/QuotaDisplay';
import RequestListPicker from '@app/components/RequestModal/RequestListPicker';
import useIsAnime from '@app/hooks/useIsAnime';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import { addToLists } from '@app/utils/addToLists';
import defineMessages from '@app/utils/defineMessages';
import { retryErrorMessage } from '@app/utils/requestServerIssue';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
import { Permission } from '@server/lib/permissions';
import type { MovieDetails } from '@server/models/Movie';
import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.RequestModal', {
  requestadmin: 'This request will be approved automatically.',
  requestSuccess: '<strong>{title}</strong> requested successfully!',
  requestCancel: 'Request for <strong>{title}</strong> canceled.',
  requestmovietitle: 'Request Movie',
  requestmovie4ktitle: 'Request Movie in 4K',
  edit: 'Edit Request',
  approve: 'Approve Request',
  cancel: 'Cancel Request',
  pendingrequest: 'Pending Movie Request',
  pending4krequest: 'Pending 4K Movie Request',
  requestfrom: "{username}'s request is pending approval.",
  errorediting: 'Something went wrong while editing the request.',
  requestedited: 'Request for <strong>{title}</strong> edited successfully!',
  requestApproved: 'Request for <strong>{title}</strong> approved!',
  requesterror: 'Something went wrong while submitting the request.',
  pendingapproval: 'Your request is pending approval.',
});

interface RequestModalProps extends React.HTMLAttributes<HTMLDivElement> {
  tmdbId: number;
  is4k?: boolean;
  editRequest?: NonFunctionProperties<MediaRequest>;
  onCancel?: () => void;
  onComplete?: (newStatus: MediaStatus) => void;
  onUpdating?: (isUpdating: boolean) => void;
}

const MovieRequestModal = ({
  onCancel,
  onComplete,
  tmdbId,
  onUpdating,
  editRequest,
  is4k = false,
}: RequestModalProps) => {
  const [isUpdating, setIsUpdating] = useState(false);
  const [requestOverrides, setRequestOverrides] =
    useState<RequestOverrides | null>(null);
  const { addToast } = useToasts();
  const { mutate: globalMutate } = useSWRConfig();
  const [listIds, setListIds] = useState<number[]>([]);
  const { data, error } = useSWR<MovieDetails>(`/api/v1/movie/${tmdbId}`, {
    revalidateOnMount: true,
  });
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const isAnime = useIsAnime();
  const animeChoice = useAnimeChoice({
    detected: !!data && isAnime(data),
    animeSetting: data?.mediaInfo?.animeSetting,
    requestSeriesType: editRequest?.seriesType,
  });
  const { data: quota } = useSWR<QuotaResponse>(
    user &&
      (!requestOverrides?.user?.id || hasPermission(Permission.MANAGE_USERS))
      ? `/api/v1/user/${requestOverrides?.user?.id ?? user.id}/quota`
      : null
  );

  useEffect(() => {
    if (onUpdating) {
      onUpdating(isUpdating);
    }
  }, [isUpdating, onUpdating]);

  const sendRequest = useCallback(async () => {
    setIsUpdating(true);

    try {
      let overrideParams = {};
      if (requestOverrides) {
        overrideParams = {
          serverId: requestOverrides.server,
          profileId: requestOverrides.profile,
          rootFolder: requestOverrides.folder,
          userId: requestOverrides.user?.id,
          tags: requestOverrides.tags,
        };
      }
      const response = await axios.post<MediaRequest>('/api/v1/request', {
        mediaId: data?.id,
        mediaType: 'movie',
        is4k,
        ignoreQuota: requestOverrides?.ignoreQuota,
        seriesType: animeChoice.seriesType,
        ...overrideParams,
      });
      globalMutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
      globalMutate('/api/v1/request/count');

      if (response.data) {
        // The request has already succeeded; adding to lists is a follow-on
        // and must not be able to make it look like it failed.
        if (listIds.length && data?.id) {
          await addToLists(listIds, data.id, 'movie', globalMutate);
        }

        if (onComplete) {
          // The server's answer, not a guess from permissions: it also
          // approves for anyone who manages requests.
          onComplete(
            response.data.status === MediaRequestStatus.PENDING
              ? MediaStatus.PENDING
              : MediaStatus.PROCESSING
          );
        }
        addToast(
          <span>
            {intl.formatMessage(messages.requestSuccess, {
              title: data?.title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
      }
    } catch {
      addToast(intl.formatMessage(messages.requesterror), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
    }
  }, [
    globalMutate,
    listIds,
    requestOverrides,
    animeChoice.seriesType,
    data?.id,
    data?.title,
    is4k,
    onComplete,
    addToast,
    intl,
  ]);

  const cancelRequest = async () => {
    setIsUpdating(true);

    try {
      const response = await axios.delete<MediaRequest>(
        `/api/v1/request/${editRequest?.id}`
      );
      globalMutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
      globalMutate('/api/v1/request/count');

      if (response.status === 204) {
        if (onComplete) {
          onComplete(MediaStatus.UNKNOWN);
        }
        addToast(
          <span>
            {intl.formatMessage(messages.requestCancel, {
              title: data?.title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
      }
    } catch {
      setIsUpdating(false);
    }
  };

  // A failed request is changed by a request manager and then retried.
  const isFailed = editRequest?.status === MediaRequestStatus.FAILED;

  const updateRequest = async (alsoApproveRequest = false) => {
    setIsUpdating(true);

    try {
      await axios.put(`/api/v1/request/${editRequest?.id}`, {
        mediaType: 'movie',
        serverId: requestOverrides?.server,
        profileId: requestOverrides?.profile,
        rootFolder: requestOverrides?.folder,
        userId: requestOverrides?.user?.id,
        tags: requestOverrides?.tags,
        seriesType: animeChoice.seriesType,
      });

      if (isFailed) {
        await axios.post(`/api/v1/request/${editRequest?.id}/retry`);
      } else if (alsoApproveRequest) {
        await axios.post(`/api/v1/request/${editRequest?.id}/approve`);
      }
      globalMutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
      globalMutate('/api/v1/request/count');

      addToast(
        <span>
          {intl.formatMessage(
            isFailed
              ? failedMessages.retried
              : alsoApproveRequest
                ? messages.requestApproved
                : messages.requestedited,
            {
              title: data?.title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            }
          )}
        </span>,
        {
          appearance: 'success',
          autoDismiss: true,
        }
      );

      if (onComplete) {
        onComplete(isFailed ? MediaStatus.PROCESSING : MediaStatus.PENDING);
      }
    } catch (e) {
      addToast(
        <span>
          {isFailed
            ? retryErrorMessage(
                e,
                intl,
                is4k,
                intl.formatMessage(messages.errorediting)
              )
            : intl.formatMessage(messages.errorediting)}
        </span>,
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    } finally {
      setIsUpdating(false);
    }
  };

  if (editRequest) {
    const isOwner = editRequest.requestedBy.id === user?.id;

    return (
      <Modal
        showCloseButton
        loading={!data && !error}
        backgroundClickable
        onCancel={onCancel}
        title={intl.formatMessage(
          isFailed
            ? is4k
              ? failedMessages.title4k
              : failedMessages.title
            : is4k
              ? messages.pending4krequest
              : messages.pendingrequest
        )}
        subTitle={data?.title}
        onOk={() =>
          isFailed
            ? updateRequest()
            : hasPermission(Permission.MANAGE_REQUESTS)
              ? updateRequest(true)
              : hasPermission(Permission.REQUEST_ADVANCED)
                ? updateRequest()
                : cancelRequest()
        }
        okDisabled={isUpdating}
        okText={
          isFailed
            ? intl.formatMessage(failedMessages.saveAndRetry)
            : hasPermission(Permission.MANAGE_REQUESTS)
              ? intl.formatMessage(messages.approve)
              : hasPermission(Permission.REQUEST_ADVANCED)
                ? intl.formatMessage(messages.edit)
                : intl.formatMessage(messages.cancel)
        }
        okButtonType={
          isFailed
            ? 'primary'
            : hasPermission(Permission.MANAGE_REQUESTS)
              ? 'success'
              : hasPermission(Permission.REQUEST_ADVANCED)
                ? 'primary'
                : 'danger'
        }
        onSecondary={
          !isFailed &&
          isOwner &&
          hasPermission(
            [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
            { type: 'or' }
          )
            ? () => cancelRequest()
            : undefined
        }
        secondaryDisabled={isUpdating}
        secondaryText={
          isOwner &&
          hasPermission(
            [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
            { type: 'or' }
          )
            ? intl.formatMessage(messages.cancel)
            : undefined
        }
        secondaryButtonType="danger"
        cancelText={intl.formatMessage(globalMessages.close)}
        backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
      >
        {isFailed ? (
          <FailedRequestAlert request={editRequest} />
        ) : isOwner ? (
          intl.formatMessage(messages.pendingapproval)
        ) : (
          intl.formatMessage(messages.requestfrom, {
            username: editRequest.requestedBy.displayName,
          })
        )}
        {data && (
          <AnimeChoice
            checked={animeChoice.anime}
            onChange={animeChoice.setAnime}
          />
        )}
        {hasPermission(
          [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
          { type: 'or' }
        ) && (
          <AdvancedRequester
            type="movie"
            tmdbId={tmdbId}
            is4k={is4k}
            isAnime={!!data && isAnime(data)}
            animeSetting={data?.mediaInfo?.animeSetting ?? null}
            requestSeriesType={editRequest.seriesType}
            animeChoice={animeChoice.choice}
            onRuleSeriesType={animeChoice.setRuleSeriesType}
            requestUser={editRequest.requestedBy}
            requestId={editRequest.id}
            // Its server was removed: it starts from the default server
            // and that server's own settings, as a new request would.
            defaultOverrides={
              editRequest.serverIssue
                ? undefined
                : {
                    folder: editRequest.rootFolder,
                    profile: editRequest.profileId,
                    server: editRequest.serverId,
                    tags: editRequest.tags,
                  }
            }
            onChange={(overrides) => {
              setRequestOverrides(overrides);
            }}
          />
        )}
      </Modal>
    );
  }

  const hasAutoApprove = hasPermission(
    [
      Permission.MANAGE_REQUESTS,
      is4k ? Permission.AUTO_APPROVE_4K : Permission.AUTO_APPROVE,
      is4k ? Permission.AUTO_APPROVE_4K_MOVIE : Permission.AUTO_APPROVE_MOVIE,
    ],
    { type: 'or' }
  );

  return (
    <Modal
      showCloseButton
      loading={(!data && !error) || !quota}
      backgroundClickable
      onCancel={onCancel}
      onOk={sendRequest}
      okDisabled={
        isUpdating ||
        (quota?.movie.restricted && !requestOverrides?.ignoreQuota)
      }
      title={intl.formatMessage(
        is4k ? messages.requestmovie4ktitle : messages.requestmovietitle
      )}
      subTitle={data?.title}
      okText={
        isUpdating
          ? intl.formatMessage(globalMessages.requesting)
          : intl.formatMessage(
              is4k ? globalMessages.request4k : globalMessages.request
            )
      }
      okButtonType={'primary'}
      backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
    >
      {hasAutoApprove && !quota?.movie.restricted && (
        <div className="mt-6">
          <Alert
            title={intl.formatMessage(messages.requestadmin)}
            type="info"
          />
        </div>
      )}
      {(quota?.movie.limit ?? 0) > 0 && (
        <QuotaDisplay
          mediaType="movie"
          quota={quota?.movie}
          userOverride={
            requestOverrides?.user && requestOverrides.user.id !== user?.id
              ? requestOverrides?.user?.id
              : undefined
          }
        />
      )}
      {data && (
        <AnimeChoice
          checked={animeChoice.anime}
          onChange={animeChoice.setAnime}
        />
      )}
      {hasPermission(
        [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
        { type: 'or' }
      ) && (
        <AdvancedRequester
          tmdbId={tmdbId}
          type="movie"
          is4k={is4k}
          isAnime={!!data && isAnime(data)}
          animeSetting={data?.mediaInfo?.animeSetting ?? null}
          animeChoice={animeChoice.choice}
          onRuleSeriesType={animeChoice.setRuleSeriesType}
          quota={quota}
          onChange={(overrides) => {
            setRequestOverrides(overrides);
          }}
        />
      )}
      <RequestListPicker
        mediaType="movie"
        onChange={setListIds}
        selected={listIds}
        tmdbId={tmdbId}
      />
    </Modal>
  );
};

export default MovieRequestModal;
