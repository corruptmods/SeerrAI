import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Modal from '@app/components/Common/Modal';
import type { RequestOverrides } from '@app/components/RequestModal/AdvancedRequester';
import AdvancedRequester from '@app/components/RequestModal/AdvancedRequester';
import AnimeChoice, {
  useAnimeChoice,
} from '@app/components/RequestModal/AnimeChoice';
import EpisodePicker from '@app/components/RequestModal/EpisodePicker';
import FollowNewSeasons from '@app/components/RequestModal/FollowNewSeasons';
import followByDefault from '@app/components/RequestModal/FollowNewSeasons/followByDefault';
import QuotaDisplay from '@app/components/RequestModal/QuotaDisplay';
import RequestListPicker from '@app/components/RequestModal/RequestListPicker';
import SearchByNameModal from '@app/components/RequestModal/SearchByNameModal';
import useFeature from '@app/hooks/useFeature';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import { addToLists } from '@app/utils/addToLists';
import defineMessages from '@app/utils/defineMessages';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type SeasonRequest from '@server/entity/SeasonRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
import { Permission } from '@server/lib/permissions';
import type { TvDetails } from '@server/models/Tv';
import { isAnime } from '@server/utils/isAnime';
import axios from 'axios';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.RequestModal', {
  requestadmin: 'This request will be approved automatically.',
  requestSuccess: '<strong>{title}</strong> requested successfully!',
  requestseriestitle: 'Request Series',
  requestseries4ktitle: 'Request Series in 4K',
  edit: 'Edit Request',
  approve: 'Approve Request',
  cancel: 'Cancel Request',
  pendingrequest: 'Pending Request',
  pending4krequest: 'Pending 4K Request',
  requestfrom: "{username}'s request is pending approval.",
  requestseasons:
    'Request {seasonCount} {seasonCount, plural, one {Season} other {Seasons}}',
  requestseasons4k:
    'Request {seasonCount} {seasonCount, plural, one {Season} other {Seasons}} in 4K',
  requestepisodes:
    'Request {episodeCount} {episodeCount, plural, one {Episode} other {Episodes}}',
  requestepisodes4k:
    'Request {episodeCount} {episodeCount, plural, one {Episode} other {Episodes}} in 4K',
  alreadyrequested: 'Already Requested',
  selectseason: 'Select Season(s)',
  season: 'Season',
  numberofepisodes: '# of Episodes',
  seasonnumber: 'Season {number}',
  allseasons: 'All seasons',
  chooseepisodes: 'Choose episodes of season {number}',
  errorediting: 'Something went wrong while editing the request.',
  requestedited: 'Request for <strong>{title}</strong> edited successfully!',
  requestApproved: 'Request for <strong>{title}</strong> approved!',
  requestcancelled: 'Request for <strong>{title}</strong> canceled.',
  autoapproval: 'Automatic Approval',
  requesterror: 'Something went wrong while submitting the request.',
  noSeasonsAvailable:
    'All of the selected seasons are already requested or available.',
  pendingapproval: 'Your request is pending approval.',
  followingNew:
    'New seasons of <strong>{title}</strong> will be requested as each premieres.',
  followFailed:
    'The request went through, but following new seasons did not. Use Get New Seasons on the series page.',
});

/** TMDB's statuses for a series that will have no more seasons. */
const FINISHED = ['Ended', 'Canceled'];

interface RequestModalProps extends React.HTMLAttributes<HTMLDivElement> {
  tmdbId: number;
  onCancel?: () => void;
  onComplete?: (newStatus: MediaStatus) => void;
  onUpdating?: (isUpdating: boolean) => void;
  is4k?: boolean;
  editRequest?: NonFunctionProperties<MediaRequest>;
  /**
   * Opens with one season, or one episode of it, already ticked — from the
   * Request buttons beside each season and episode on the series page.
   */
  preselect?: RequestPreselect;
}

export interface RequestPreselect {
  seasonNumber: number;
  episodeNumber?: number;
}

const TvRequestModal = ({
  onCancel,
  onComplete,
  tmdbId,
  onUpdating,
  editRequest,
  is4k = false,
  preselect,
}: RequestModalProps) => {
  const settings = useSettings();
  const { addToast } = useToasts();
  const { mutate: globalMutate } = useSWRConfig();
  const [listIds, setListIds] = useState<number[]>([]);
  const editingSeasons: number[] = (editRequest?.seasons ?? []).map(
    (season) => season.seasonNumber
  );
  const { data, error } = useSWR<TvDetails>(`/api/v1/tv/${tmdbId}`);
  const [requestOverrides, setRequestOverrides] =
    useState<RequestOverrides | null>(null);
  const animeChoice = useAnimeChoice({
    detected: !!data && isAnime(data),
    animeSetting: data?.mediaInfo?.animeSetting,
    requestSeriesType: editRequest?.seriesType,
  });
  // Choosing single episodes is for a new request, and only while partial
  // requests are on: editing a request changes its seasons, never which
  // episodes of them it holds, and with partial requests off every request
  // is for whole seasons.
  const pickEpisodes =
    !editRequest && settings.currentSettings.partialRequestsEnabled;
  // Per-season episode selection. A season absent here, or mapped to an empty
  // array, means the whole season — which is what the API expects too.
  // A preselected episode is its season with just that episode picked; an
  // edit starts from the request itself and ignores it.
  const start = !editRequest ? preselect : undefined;
  const [selectedEpisodes, setSelectedEpisodes] = useState<
    Record<number, number[]>
  >(
    pickEpisodes && start?.episodeNumber !== undefined
      ? { [start.seasonNumber]: [start.episodeNumber] }
      : {}
  );
  const [expandedSeason, setExpandedSeason] = useState<number | null>(
    pickEpisodes && start?.episodeNumber !== undefined
      ? start.seasonNumber
      : null
  );

  const [selectedSeasons, setSelectedSeasons] = useState<number[]>(
    editRequest ? editingSeasons : start ? [start.seasonNumber] : []
  );
  // Following the series from here on, offered alongside a new request.
  const followFeature = useFeature('newSeasons');
  const { data: followState } = useSWR<{ following: boolean }>(
    followFeature && !editRequest && !is4k
      ? `/api/v1/tv/${tmdbId}/future-seasons`
      : null
  );
  const [followChoice, setFollowChoice] = useState<boolean>();
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const [searchModal, setSearchModal] = useState<{
    show: boolean;
  }>({
    show: true,
  });
  const [tvdbId, setTvdbId] = useState<number | undefined>(undefined);
  const { data: quota } = useSWR<QuotaResponse>(
    user &&
      (!requestOverrides?.user?.id || hasPermission(Permission.MANAGE_USERS))
      ? `/api/v1/user/${requestOverrides?.user?.id ?? user.id}/quota`
      : null
  );

  const latestAired = Math.max(
    0,
    ...(data?.seasons ?? [])
      .filter(
        (season) =>
          season.seasonNumber > 0 &&
          !!season.airDate &&
          Date.parse(season.airDate) <= Date.now()
      )
      .map((season) => season.seasonNumber)
  );
  // Not for a request made on someone else's behalf: it would follow the
  // series for whoever is signed in, not them.
  const offerFollow =
    !!data &&
    followState?.following === false &&
    !FINISHED.includes(data.status) &&
    (!requestOverrides?.user || requestOverrides.user.id === user?.id);

  const currentlyRemaining =
    (quota?.tv.remaining ?? 0) -
    selectedSeasons.length +
    (editRequest?.seasons ?? []).length;

  // The server answers 202, with only a message, when every season asked
  // for is already requested or in the library: nothing new was asked for.
  // That is not an error. The seasons are fetched again so the list shows
  // what already covers them.
  const seasonsAlreadyCovered = () => {
    addToast(intl.formatMessage(messages.noSeasonsAvailable), {
      appearance: 'info',
      autoDismiss: true,
    });
    globalMutate(`/api/v1/tv/${tmdbId}`);
  };

  const updateRequest = async (alsoApproveRequest = false) => {
    if (!editRequest) {
      return;
    }

    if (onUpdating) {
      onUpdating(true);
      globalMutate('/api/v1/request/count');
    }

    try {
      if (selectedSeasons.length > 0) {
        const response = await axios.put(`/api/v1/request/${editRequest.id}`, {
          mediaType: 'tv',
          serverId: requestOverrides?.server,
          profileId: requestOverrides?.profile,
          rootFolder: requestOverrides?.folder,
          languageProfileId: requestOverrides?.language,
          userId: requestOverrides?.user?.id,
          tags: requestOverrides?.tags,
          seriesType: animeChoice.seriesType,
          seasons: selectedSeasons.sort((a, b) => a - b),
        });

        // The edit would leave the request with no season of its own, so
        // the server changed nothing; there is nothing to approve either.
        if (response.status === 202) {
          seasonsAlreadyCovered();
          return;
        }

        if (alsoApproveRequest) {
          await axios.post(`/api/v1/request/${editRequest.id}/approve`);
        }
      } else {
        await axios.delete(`/api/v1/request/${editRequest.id}`);
      }
      globalMutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
      globalMutate('/api/v1/request/count');

      addToast(
        <span>
          {selectedSeasons.length > 0
            ? intl.formatMessage(
                alsoApproveRequest
                  ? messages.requestApproved
                  : messages.requestedited,
                {
                  title: data?.name,
                  strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
                }
              )
            : intl.formatMessage(messages.requestcancelled, {
                title: data?.name,
                strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
              })}
        </span>,
        {
          appearance: 'success',
          autoDismiss: true,
        }
      );
      if (onComplete) {
        onComplete(MediaStatus.PENDING);
      }
    } catch {
      addToast(<span>{intl.formatMessage(messages.errorediting)}</span>, {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      if (onUpdating) {
        onUpdating(false);
      }
    }
  };

  const sendRequest = async () => {
    if (
      settings.currentSettings.partialRequestsEnabled &&
      selectedSeasons.length === 0
    ) {
      return;
    }

    if (onUpdating) {
      onUpdating(true);
      globalMutate('/api/v1/request/count');
    }

    try {
      let overrideParams = {};
      if (requestOverrides) {
        overrideParams = {
          serverId: requestOverrides.server,
          profileId: requestOverrides.profile,
          rootFolder: requestOverrides.folder,
          languageProfileId: requestOverrides.language,
          userId: requestOverrides?.user?.id,
          tags: requestOverrides.tags,
        };
      }
      const response = await axios.post<MediaRequest>('/api/v1/request', {
        mediaId: data?.id,
        tvdbId: tvdbId ?? data?.externalIds.tvdbId,
        mediaType: 'tv',
        is4k,
        ignoreQuota: requestOverrides?.ignoreQuota,
        seriesType: animeChoice.seriesType,
        seasons: settings.currentSettings.partialRequestsEnabled
          ? selectedSeasons.sort((a, b) => a - b)
          : getAllSeasons().filter(
              (season) => !getAllRequestedSeasons().includes(season)
            ),
        ...(pickEpisodes ? { episodes: selectedEpisodes } : {}),
        ...overrideParams,
      });
      globalMutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');

      // Nothing was requested, so nothing is put on lists or followed.
      if (response.status === 202) {
        seasonsAlreadyCovered();
        return;
      }

      if (response.data) {
        // The request has already succeeded; adding to lists is a follow-on
        // and must not be able to make it look like it failed.
        if (listIds.length && data?.id) {
          await addToLists(listIds, data.id, 'tv', globalMutate);
        }

        // Likewise a follow-on: the request stands whatever happens here.
        if (offerFollow && follow) {
          try {
            await axios.post(`/api/v1/tv/${tmdbId}/future-seasons`);
            globalMutate(`/api/v1/tv/${tmdbId}/future-seasons`);
            addToast(
              <span>
                {intl.formatMessage(messages.followingNew, {
                  title: data?.name,
                  strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
                })}
              </span>,
              { appearance: 'success', autoDismiss: true }
            );
          } catch {
            addToast(intl.formatMessage(messages.followFailed), {
              appearance: 'warning',
              autoDismiss: true,
            });
          }
        }

        if (onComplete) {
          onComplete(response.data.media.status);
        }
        addToast(
          <span>
            {intl.formatMessage(messages.requestSuccess, {
              title: data?.name,
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
      if (onUpdating) {
        onUpdating(false);
      }
    }
  };

  const getAllSeasons = (): number[] => {
    let allSeasons = (data?.seasons ?? []).filter(
      (season) => season.episodeCount !== 0
    );
    if (!settings.currentSettings.enableSpecialEpisodes) {
      allSeasons = allSeasons.filter((season) => season.seasonNumber > 0);
    }
    return allSeasons.map((season) => season.seasonNumber);
  };

  const getAllRequestedSeasons = (): number[] => {
    const requestedSeasons = (data?.mediaInfo?.requests ?? [])
      .filter(
        (request) =>
          request.is4k === is4k &&
          request.status !== MediaRequestStatus.DECLINED &&
          request.status !== MediaRequestStatus.COMPLETED
      )
      .reduce((requestedSeasons, request) => {
        return [
          ...requestedSeasons,
          ...request.seasons
            .filter((season) => !editingSeasons.includes(season.seasonNumber))
            .map((sr) => sr.seasonNumber),
        ];
      }, [] as number[]);

    const availableSeasons = (data?.mediaInfo?.seasons ?? [])
      .filter(
        (season) =>
          (season[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE ||
            season[is4k ? 'status4k' : 'status'] ===
              MediaStatus.PARTIALLY_AVAILABLE ||
            season[is4k ? 'status4k' : 'status'] === MediaStatus.PROCESSING) &&
          !requestedSeasons.includes(season.seasonNumber)
      )
      .map((season) => season.seasonNumber);

    return [...requestedSeasons, ...availableSeasons];
  };

  const isSelectedSeason = (seasonNumber: number): boolean =>
    selectedSeasons.includes(seasonNumber);

  const toggleSeason = (seasonNumber: number): void => {
    // If this season already has a pending request, don't allow it to be toggled
    if (getAllRequestedSeasons().includes(seasonNumber)) {
      return;
    }

    // If there are no more remaining requests available, block toggle
    if (
      quota?.tv.limit &&
      currentlyRemaining <= 0 &&
      !isSelectedSeason(seasonNumber)
    ) {
      return;
    }

    // Toggling the season, either way, clears any partial episode selection:
    // on means the whole season, off means none of it.
    setSelectedEpisodes((current) => {
      const next = { ...current };
      delete next[seasonNumber];
      return next;
    });

    if (selectedSeasons.includes(seasonNumber)) {
      setSelectedSeasons((seasons) =>
        seasons.filter((sn) => sn !== seasonNumber)
      );
    } else {
      setSelectedSeasons((seasons) => [...seasons, seasonNumber]);
    }
  };

  /**
   * Called by the episode picker with the full set of episodes the user now
   * wants from a season. Keeps the season toggle in step: none selected turns
   * the season off, every episode selected turns it on as a whole season, and
   * anything in between turns it on with a partial selection.
   */
  const setSeasonEpisodes = (
    seasonNumber: number,
    episodeNumbers: number[],
    totalEpisodes: number
  ): void => {
    if (getAllRequestedSeasons().includes(seasonNumber)) {
      return;
    }

    const isWhole =
      totalEpisodes > 0 && episodeNumbers.length === totalEpisodes;
    const isNone = episodeNumbers.length === 0;

    setSelectedEpisodes((current) => {
      const next = { ...current };

      if (isWhole || isNone) {
        delete next[seasonNumber];
      } else {
        next[seasonNumber] = episodeNumbers;
      }

      return next;
    });

    setSelectedSeasons((seasons) => {
      const has = seasons.includes(seasonNumber);

      if (isNone) {
        return has ? seasons.filter((sn) => sn !== seasonNumber) : seasons;
      }

      return has ? seasons : [...seasons, seasonNumber];
    });
  };

  const unrequestedSeasons = getAllSeasons().filter(
    (season) => !getAllRequestedSeasons().includes(season)
  );

  // Starts ticked when the request takes every season, or just the newest;
  // anyone can untick it, and their choice then stands.
  const follow =
    followChoice ??
    followByDefault({
      partialRequestsEnabled: settings.currentSettings.partialRequestsEnabled,
      selected: selectedSeasons,
      requestable: unrequestedSeasons,
      partSeasons: Object.keys(selectedEpisodes).map(Number),
      latestAired,
    });

  const toggleAllSeasons = (): void => {
    // If the user has a quota and not enough requests for all seasons, block toggleAllSeasons
    if (
      quota?.tv.limit &&
      (quota?.tv.remaining ?? 0) < unrequestedSeasons.length
    ) {
      return;
    }

    // Either way any episodes picked go: all seasons means every season
    // whole, and none means nothing from any of them.
    setSelectedEpisodes({});

    if (
      data &&
      selectedSeasons.length >= 0 &&
      selectedSeasons.length < unrequestedSeasons.length
    ) {
      setSelectedSeasons(unrequestedSeasons);
    } else {
      setSelectedSeasons([]);
    }
  };

  const isAllSeasons = (): boolean => {
    if (!data) {
      return false;
    }
    return (
      selectedSeasons.filter((season) => season !== 0).length ===
      getAllSeasons().filter(
        (season) => !getAllRequestedSeasons().includes(season) && season !== 0
      ).length
    );
  };

  const getSeasonRequest = (
    seasonNumber: number
  ): SeasonRequest | undefined => {
    let seasonRequest: SeasonRequest | undefined;

    if (
      data?.mediaInfo &&
      (data.mediaInfo.requests || []).filter(
        (request) =>
          request.is4k === is4k &&
          request.status !== MediaRequestStatus.DECLINED &&
          request.status !== MediaRequestStatus.COMPLETED
      ).length > 0
    ) {
      data.mediaInfo.requests
        .filter(
          (request) =>
            request.is4k === is4k &&
            request.status !== MediaRequestStatus.DECLINED &&
            request.status !== MediaRequestStatus.COMPLETED
        )
        .forEach((request) => {
          if (!seasonRequest) {
            seasonRequest = request.seasons.find(
              (season) =>
                season.seasonNumber === seasonNumber &&
                season.status !== MediaRequestStatus.COMPLETED
            );
          }
        });
    }

    return seasonRequest;
  };

  const isOwner = editRequest && editRequest.requestedBy.id === user?.id;

  return data && !error && !data.externalIds.tvdbId && searchModal.show ? (
    <SearchByNameModal
      tvdbId={tvdbId}
      setTvdbId={setTvdbId}
      closeModal={() => setSearchModal({ show: false })}
      onCancel={onCancel}
      modalTitle={intl.formatMessage(
        is4k ? messages.requestseries4ktitle : messages.requestseriestitle
      )}
      modalSubTitle={data.name}
      tmdbId={tmdbId}
      backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
    />
  ) : (
    <Modal
      showCloseButton
      loading={!data && !error}
      backgroundClickable
      onCancel={tvdbId ? () => setSearchModal({ show: true }) : onCancel}
      onOk={() =>
        editRequest
          ? hasPermission(Permission.MANAGE_REQUESTS)
            ? updateRequest(true)
            : updateRequest()
          : sendRequest()
      }
      title={intl.formatMessage(
        editRequest
          ? is4k
            ? messages.pending4krequest
            : messages.pendingrequest
          : is4k
            ? messages.requestseries4ktitle
            : messages.requestseriestitle
      )}
      subTitle={data?.name}
      okText={
        editRequest
          ? selectedSeasons.length === 0
            ? intl.formatMessage(messages.cancel)
            : hasPermission(Permission.MANAGE_REQUESTS)
              ? intl.formatMessage(messages.approve)
              : intl.formatMessage(messages.edit)
          : unrequestedSeasons.length === 0
            ? intl.formatMessage(messages.alreadyrequested)
            : !settings.currentSettings.partialRequestsEnabled
              ? intl.formatMessage(
                  is4k ? globalMessages.request4k : globalMessages.request
                )
              : selectedSeasons.length === 0
                ? intl.formatMessage(messages.selectseason)
                : // Name what is being asked for: episodes when every
                  // ticked season is narrowed to some, seasons otherwise.
                  selectedSeasons.every(
                      (season) => (selectedEpisodes[season] ?? []).length > 0
                    )
                  ? intl.formatMessage(
                      is4k
                        ? messages.requestepisodes4k
                        : messages.requestepisodes,
                      {
                        episodeCount: selectedSeasons.reduce(
                          (sum, season) =>
                            sum + (selectedEpisodes[season] ?? []).length,
                          0
                        ),
                      }
                    )
                  : intl.formatMessage(
                      is4k
                        ? messages.requestseasons4k
                        : messages.requestseasons,
                      {
                        seasonCount: selectedSeasons.length,
                      }
                    )
      }
      okDisabled={
        editRequest
          ? false
          : !settings.currentSettings.partialRequestsEnabled &&
              quota?.tv.limit &&
              unrequestedSeasons.length > quota.tv.limit &&
              !requestOverrides?.ignoreQuota
            ? true
            : unrequestedSeasons.length === 0 ||
              (settings.currentSettings.partialRequestsEnabled &&
                selectedSeasons.length === 0)
      }
      okButtonType={
        editRequest
          ? settings.currentSettings.partialRequestsEnabled &&
            selectedSeasons.length === 0
            ? 'danger'
            : hasPermission(Permission.MANAGE_REQUESTS)
              ? 'success'
              : 'primary'
          : 'primary'
      }
      cancelText={
        editRequest
          ? intl.formatMessage(globalMessages.close)
          : tvdbId
            ? intl.formatMessage(globalMessages.back)
            : intl.formatMessage(globalMessages.cancel)
      }
      backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
    >
      {editRequest
        ? isOwner
          ? intl.formatMessage(messages.pendingapproval)
          : intl.formatMessage(messages.requestfrom, {
              username: editRequest?.requestedBy.displayName,
            })
        : null}
      {hasPermission(
        [
          Permission.MANAGE_REQUESTS,
          is4k ? Permission.AUTO_APPROVE_4K : Permission.AUTO_APPROVE,
          is4k ? Permission.AUTO_APPROVE_4K_TV : Permission.AUTO_APPROVE_TV,
        ],
        { type: 'or' }
      ) &&
        !(
          quota?.tv.limit &&
          !settings.currentSettings.partialRequestsEnabled &&
          unrequestedSeasons.length > (quota?.tv.remaining ?? 0)
        ) &&
        getAllRequestedSeasons().length < getAllSeasons().length &&
        !editRequest && (
          <div className="mt-6">
            <Alert
              title={intl.formatMessage(messages.requestadmin)}
              type="info"
            />
          </div>
        )}
      {(quota?.tv.limit ?? 0) > 0 && (
        <QuotaDisplay
          mediaType="tv"
          quota={quota?.tv}
          remaining={
            !settings.currentSettings.partialRequestsEnabled &&
            unrequestedSeasons.length > (quota?.tv.remaining ?? 0)
              ? 0
              : currentlyRemaining
          }
          userOverride={
            requestOverrides?.user && requestOverrides.user.id !== user?.id
              ? requestOverrides?.user?.id
              : undefined
          }
          overLimit={
            !settings.currentSettings.partialRequestsEnabled &&
            unrequestedSeasons.length > (quota?.tv.remaining ?? 0)
              ? unrequestedSeasons.length
              : undefined
          }
        />
      )}
      <div className="flex flex-col">
        <div className="-mx-4 sm:mx-0">
          <div className="inline-block min-w-full py-2 align-middle">
            <div className="overflow-hidden border border-gray-700 shadow backdrop-blur sm:rounded-lg">
              <table className="min-w-full">
                <thead>
                  <tr>
                    <th
                      className={`w-16 bg-gray-700/80 px-4 py-3 ${
                        !settings.currentSettings.partialRequestsEnabled &&
                        'hidden'
                      }`}
                    >
                      <span
                        role="checkbox"
                        tabIndex={0}
                        aria-checked={isAllSeasons()}
                        aria-label={intl.formatMessage(messages.allseasons)}
                        onClick={() => toggleAllSeasons()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleAllSeasons();
                          }
                        }}
                        className={`relative inline-flex h-5 w-10 flex-shrink-0 cursor-pointer items-center justify-center rounded-full pt-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                          quota?.tv.remaining &&
                          quota.tv.limit &&
                          quota.tv.remaining < unrequestedSeasons.length
                            ? 'opacity-50'
                            : ''
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`${
                            isAllSeasons() ? 'bg-indigo-500' : 'bg-gray-800'
                          } absolute mx-auto h-4 w-9 rounded-full transition-colors duration-200 ease-in-out`}
                        />
                        <span
                          aria-hidden="true"
                          className={`${
                            isAllSeasons() ? 'translate-x-5' : 'translate-x-0'
                          } absolute left-0 inline-block h-5 w-5 rounded-full border border-gray-200 bg-white shadow transition-transform duration-200 ease-in-out group-focus:border-blue-300 group-focus:ring`}
                        />
                      </span>
                    </th>
                    <th className="bg-gray-700/80 px-1 py-3 text-left text-xs font-medium uppercase leading-4 tracking-wider text-gray-200 md:px-6">
                      {intl.formatMessage(messages.season)}
                    </th>
                    <th className="bg-gray-700/80 px-5 py-3 text-left text-xs font-medium uppercase leading-4 tracking-wider text-gray-200 md:px-6">
                      {intl.formatMessage(messages.numberofepisodes)}
                    </th>
                    <th className="bg-gray-700/80 px-2 py-3 text-left text-xs font-medium uppercase leading-4 tracking-wider text-gray-200 md:px-6">
                      {intl.formatMessage(globalMessages.status)}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {data?.seasons
                    .filter(
                      (season) =>
                        season.episodeCount !== 0 &&
                        (settings.currentSettings.enableSpecialEpisodes ||
                          season.seasonNumber !== 0)
                    )
                    .map((season) => {
                      const seasonRequest = getSeasonRequest(
                        season.seasonNumber
                      );
                      const mediaSeason = data?.mediaInfo?.seasons.find(
                        (sn) =>
                          sn.seasonNumber === season.seasonNumber &&
                          sn[is4k ? 'status4k' : 'status'] !==
                            MediaStatus.UNKNOWN &&
                          sn[is4k ? 'status4k' : 'status'] !==
                            MediaStatus.DELETED
                      );
                      return (
                        <Fragment key={`season-${season.id}`}>
                          <tr>
                            <td
                              className={`whitespace-nowrap px-4 py-4 text-sm font-medium leading-5 text-gray-100 ${
                                !settings.currentSettings
                                  .partialRequestsEnabled && 'hidden'
                              }`}
                            >
                              <span
                                role="checkbox"
                                tabIndex={0}
                                aria-label={
                                  season.seasonNumber === 0
                                    ? intl.formatMessage(
                                        globalMessages.specials
                                      )
                                    : intl.formatMessage(
                                        messages.seasonnumber,
                                        {
                                          number: season.seasonNumber,
                                        }
                                      )
                                }
                                aria-checked={
                                  !!mediaSeason ||
                                  (!!seasonRequest &&
                                    !editingSeasons.includes(
                                      season.seasonNumber
                                    )) ||
                                  isSelectedSeason(season.seasonNumber)
                                }
                                onClick={() =>
                                  toggleSeason(season.seasonNumber)
                                }
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    toggleSeason(season.seasonNumber);
                                  }
                                }}
                                className={`relative inline-flex h-5 w-10 flex-shrink-0 cursor-pointer items-center justify-center rounded-full pt-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                                  mediaSeason ||
                                  (quota?.tv.limit &&
                                    currentlyRemaining <= 0 &&
                                    !isSelectedSeason(season.seasonNumber)) ||
                                  (!!seasonRequest &&
                                    !editingSeasons.includes(
                                      season.seasonNumber
                                    ))
                                    ? 'opacity-50'
                                    : ''
                                }`}
                              >
                                <span
                                  aria-hidden="true"
                                  className={`${
                                    !!mediaSeason ||
                                    (!!seasonRequest &&
                                      !editingSeasons.includes(
                                        season.seasonNumber
                                      )) ||
                                    isSelectedSeason(season.seasonNumber)
                                      ? 'bg-indigo-500'
                                      : 'bg-gray-700'
                                  } absolute mx-auto h-4 w-9 rounded-full transition-colors duration-200 ease-in-out`}
                                />
                                <span
                                  aria-hidden="true"
                                  className={`${
                                    !!mediaSeason ||
                                    (!!seasonRequest &&
                                      !editingSeasons.includes(
                                        season.seasonNumber
                                      )) ||
                                    isSelectedSeason(season.seasonNumber)
                                      ? 'translate-x-5'
                                      : 'translate-x-0'
                                  } absolute left-0 inline-block h-5 w-5 rounded-full border border-gray-200 bg-white shadow transition-transform duration-200 ease-in-out group-focus:border-blue-300 group-focus:ring`}
                                />
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-1 py-4 text-sm font-medium leading-5 text-gray-100 md:px-6">
                              {season.seasonNumber === 0
                                ? intl.formatMessage(globalMessages.specials)
                                : intl.formatMessage(messages.seasonnumber, {
                                    number: season.seasonNumber,
                                  })}
                            </td>
                            <td className="whitespace-nowrap px-5 py-4 text-sm leading-5 text-gray-200 md:px-6">
                              <div className="flex items-center space-x-2">
                                <span>{season.episodeCount}</span>
                                {pickEpisodes && season.seasonNumber > 0 && (
                                  <button
                                    aria-label={intl.formatMessage(
                                      messages.chooseepisodes,
                                      { number: season.seasonNumber }
                                    )}
                                    aria-expanded={
                                      expandedSeason === season.seasonNumber
                                    }
                                    aria-controls={`season-${season.seasonNumber}-episodes`}
                                    className="rounded text-gray-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                                    onClick={() =>
                                      setExpandedSeason(
                                        expandedSeason === season.seasonNumber
                                          ? null
                                          : season.seasonNumber
                                      )
                                    }
                                    type="button"
                                  >
                                    <ChevronDownIcon
                                      className={`h-4 w-4 transition-transform ${
                                        expandedSeason === season.seasonNumber
                                          ? 'rotate-180'
                                          : ''
                                      }`}
                                    />
                                  </button>
                                )}
                              </div>
                            </td>
                            <td className="whitespace-nowrap py-4 pr-2 text-sm leading-5 text-gray-200 md:px-6">
                              {!seasonRequest && !mediaSeason && (
                                <Badge>
                                  {intl.formatMessage(
                                    globalMessages.notrequested
                                  )}
                                </Badge>
                              )}
                              {!mediaSeason &&
                                seasonRequest?.status ===
                                  MediaRequestStatus.PENDING && (
                                  <Badge badgeType="warning">
                                    {intl.formatMessage(globalMessages.pending)}
                                  </Badge>
                                )}
                              {((!mediaSeason &&
                                seasonRequest?.status ===
                                  MediaRequestStatus.APPROVED) ||
                                mediaSeason?.[is4k ? 'status4k' : 'status'] ===
                                  MediaStatus.PROCESSING) && (
                                <Badge badgeType="primary">
                                  {intl.formatMessage(globalMessages.requested)}
                                </Badge>
                              )}
                              {mediaSeason?.[is4k ? 'status4k' : 'status'] ===
                                MediaStatus.PARTIALLY_AVAILABLE && (
                                <Badge badgeType="success">
                                  {intl.formatMessage(
                                    globalMessages.partiallyavailable
                                  )}
                                </Badge>
                              )}
                              {mediaSeason?.[is4k ? 'status4k' : 'status'] ===
                                MediaStatus.AVAILABLE && (
                                <Badge badgeType="success">
                                  {intl.formatMessage(globalMessages.available)}
                                </Badge>
                              )}
                            </td>
                          </tr>
                          {pickEpisodes &&
                            expandedSeason === season.seasonNumber && (
                              <tr key={`season-${season.id}-episodes`}>
                                <td
                                  className="bg-gray-800 p-0"
                                  colSpan={4}
                                  id={`season-${season.seasonNumber}-episodes`}
                                >
                                  <EpisodePicker
                                    tvId={data?.id as number}
                                    seasonNumber={season.seasonNumber}
                                    seasonSelected={isSelectedSeason(
                                      season.seasonNumber
                                    )}
                                    selected={
                                      selectedEpisodes[season.seasonNumber]
                                    }
                                    onChange={(
                                      episodeNumbers: number[],
                                      totalEpisodes: number
                                    ) =>
                                      setSeasonEpisodes(
                                        season.seasonNumber,
                                        episodeNumbers,
                                        totalEpisodes
                                      )
                                    }
                                  />
                                </td>
                              </tr>
                            )}
                        </Fragment>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      {data && (
        <AnimeChoice
          checked={animeChoice.anime}
          onChange={animeChoice.setAnime}
        />
      )}
      {offerFollow && (
        <FollowNewSeasons checked={follow} onChange={setFollowChoice} />
      )}
      {hasPermission(
        [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
        { type: 'or' }
      ) && (
        <AdvancedRequester
          type="tv"
          tmdbId={tmdbId}
          is4k={is4k}
          isAnime={!!data && isAnime(data)}
          animeSetting={data?.mediaInfo?.animeSetting ?? null}
          requestSeriesType={editRequest?.seriesType}
          animeChoice={animeChoice.choice}
          onRuleSeriesType={animeChoice.setRuleSeriesType}
          quota={quota}
          onChange={(overrides) => setRequestOverrides(overrides)}
          requestUser={editRequest?.requestedBy}
          requestId={editRequest?.id}
          defaultOverrides={
            editRequest
              ? {
                  folder: editRequest.rootFolder,
                  profile: editRequest.profileId,
                  server: editRequest.serverId,
                  language: editRequest.languageProfileId,
                  tags: editRequest.tags,
                }
              : undefined
          }
        />
      )}
      <RequestListPicker
        mediaType="tv"
        onChange={setListIds}
        selected={listIds}
        tmdbId={tmdbId}
      />
    </Modal>
  );
};

export default TvRequestModal;
