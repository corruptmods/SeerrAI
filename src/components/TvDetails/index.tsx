import RTAudFresh from '@app/assets/rt_aud_fresh.svg';
import RTAudRotten from '@app/assets/rt_aud_rotten.svg';
import RTFresh from '@app/assets/rt_fresh.svg';
import RTRotten from '@app/assets/rt_rotten.svg';
import ImdbLogo from '@app/assets/services/imdb.svg';
import Spinner from '@app/assets/spinner.svg';
import TmdbLogo from '@app/assets/tmdb_logo.svg';
import AddToList from '@app/components/AddToList';
import CatchMeUp from '@app/components/Ai/CatchMeUp';
import BackfillForTitle from '@app/components/Backfill/ForTitle';
import BackfillTitleButton from '@app/components/Backfill/TitleButton';
import BlocklistModal from '@app/components/BlocklistModal';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import Flag from '@app/components/Common/Flag';
import { MediaPageSkeleton } from '@app/components/Common/PageSkeleton';
import PageTitle from '@app/components/Common/PageTitle';
import type { PlayButtonLink } from '@app/components/Common/PlayButton';
import PlayButton from '@app/components/Common/PlayButton';
import StatusBadgeMini from '@app/components/Common/StatusBadgeMini';
import Tag from '@app/components/Common/Tag';
import Tooltip from '@app/components/Common/Tooltip';
import TitleDeclineReason from '@app/components/DeclineReason/TitleDeclineReason';
import { DeletingSoonBadge, KeepButton } from '@app/components/DeletingSoon';
import ExternalLinkBlock from '@app/components/ExternalLinkBlock';
import IssueModal from '@app/components/IssueModal';
import ManageSlideOver from '@app/components/ManageSlideOver';
import MediaSlider from '@app/components/MediaSlider';
import PersonCard from '@app/components/PersonCard';
import PlexMatchWarning from '@app/components/PlexMatchWarning';
import RequestButton from '@app/components/RequestButton';
import TitleEta from '@app/components/RequestEta/TitleEta';
import RequestModal from '@app/components/RequestModal';
import type { RequestPreselect } from '@app/components/RequestModal/TvRequestModal';
import RequestedBy from '@app/components/RequestedBy';
import Slider from '@app/components/Slider';
import StatusBadge from '@app/components/StatusBadge';
import { SeasonSubtitleBadge } from '@app/components/Subtitles/EpisodeSubtitles';
import SubtitlesCard from '@app/components/Subtitles/SubtitlesCard';
import FutureSeasonsButton from '@app/components/TvDetails/FutureSeasonsButton';
import Season from '@app/components/TvDetails/Season';
import WatchedBy from '@app/components/WatchedBy';
import useIsAnime from '@app/hooks/useIsAnime';
import useLocale from '@app/hooks/useLocale';
import usePlayLinks from '@app/hooks/usePlayLinks';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import blocklistAction from '@app/utils/blocklistAction';
import { sortCrewPriority } from '@app/utils/creditHelpers';
import defineMessages from '@app/utils/defineMessages';
import { titleBackdrop, titlePoster } from '@app/utils/imageSources';
import { hasAccountOn } from '@app/utils/mediaServerAccounts';
import {
  refreshIntervalHelper,
  watchMedia,
} from '@app/utils/refreshIntervalHelper';
import {
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
  Transition,
} from '@headlessui/react';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import {
  ArrowRightCircleIcon,
  CogIcon,
  ExclamationTriangleIcon,
  EyeSlashIcon,
  FilmIcon,
  MinusCircleIcon,
  PlayIcon,
  StarIcon,
} from '@heroicons/react/24/solid';
import type { RatingResponse } from '@server/api/ratings';
import { IssueStatus } from '@server/constants/issue';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import type { TvDetails as TvDetailsType } from '@server/models/Tv';
import type { Crew } from '@server/models/common';
import axios from 'axios';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.TvDetails', {
  firstAirDate: 'First Air Date',
  nextAirDate: 'Next Air Date',
  originallanguage: 'Original Language',
  overview: 'Overview',
  cast: 'Cast',
  recommendations: 'Recommendations',
  similar: 'Similar Series',
  watchtrailer: 'Watch Trailer',
  overviewunavailable: 'Overview unavailable.',
  originaltitle: 'Original Title',
  showtype: 'Series Type',
  anime: 'Anime',
  network: '{networkCount, plural, one {Network} other {Networks}}',
  viewfullcrew: 'View Full Crew',
  play: 'Play on {mediaServerName}',
  play4k: 'Play 4K on {mediaServerName}',
  seasons: '{seasonCount, plural, one {# Season} other {# Seasons}}',
  episodeRuntime: 'Episode Runtime',
  episodeRuntimeMinutes: '{runtime} minutes',
  streamingproviders: 'Currently Streaming On',
  productioncountries:
    'Production {countryCount, plural, one {Country} other {Countries}}',
  reportissue: 'Report an Issue',
  manageseries: 'Manage Series',
  seasonstitle: 'Seasons',
  episodeCount: '{episodeCount, plural, one {# Episode} other {# Episodes}}',
  seasonnumber: 'Season {seasonNumber}',
  status4k: '4K {status}',
  rtcriticsscore: 'Rotten Tomatoes Tomatometer',
  rtaudiencescore: 'Rotten Tomatoes Audience Score',
  tmdbuserscore: 'TMDB User Score',
  imdbuserscore: 'IMDB User Score – votes: {formattedCount}',
  watchlistSuccess: '<strong>{title}</strong> added to watchlist successfully!',
  watchlistDeleted:
    '<strong>{title}</strong> Removed from watchlist successfully!',
  watchlistError: 'Something went wrong. Please try again.',
  removefromwatchlist: 'Remove From Watchlist',
  addtowatchlist: 'Add To Watchlist',
});

interface TvDetailsProps {
  tv?: TvDetailsType;
}

const TvDetails = ({ tv }: TvDetailsProps) => {
  const settings = useSettings();
  const isAnime = useIsAnime();
  const { user, hasPermission } = useUser();
  const router = useRouter();
  const intl = useIntl();
  const { locale } = useLocale();
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [showManager, setShowManager] = useState(false);
  // A season, or one episode of it, being requested from its own button.
  const [requestFor, setRequestFor] = useState<RequestPreselect | null>(null);
  const { mutate: mutateCache } = useSWRConfig();
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [toggleWatchlist, setToggleWatchlist] = useState<boolean>(
    !tv?.onUserWatchlist
  );
  const [isBlocklistUpdating, setIsBlocklistUpdating] =
    useState<boolean>(false);
  const [showBlocklistModal, setShowBlocklistModal] = useState(false);
  const { addToast } = useToasts();

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<TvDetailsType>(`/api/v1/tv/${router.query.tvId}`, {
    fallbackData: tv,
    refreshInterval: refreshIntervalHelper<TvDetailsType>(
      (latest) => watchMedia(latest.mediaInfo),
      tv
    ),
  });

  const { data: ratings } = useSWR<RatingResponse>(
    `/api/v1/tv/${router.query.tvId}/ratingscombined`
  );
  const ratingData = ratings?.rt;
  const imdbRating = ratings?.imdb;

  const sortedCrew = useMemo(
    () => sortCrewPriority(data?.credits.crew ?? []),
    [data]
  );

  useEffect(() => {
    if (router.query.manage === '1') {
      setShowManager(true);
      router.replace({
        pathname: router.pathname,
        query: { tvId: router.query.tvId },
      });
    }
  }, [router, router.query.manage]);

  const closeBlocklistModal = useCallback(
    () => setShowBlocklistModal(false),
    []
  );

  const {
    links: playLinks,
    playLink,
    playLink4k,
  } = usePlayLinks(data?.mediaInfo);

  if (!data && !error) {
    return <MediaPageSkeleton />;
  }

  if (!data) {
    return <ErrorPage statusCode={404} />;
  }

  const mediaLinks: PlayButtonLink[] = [];

  // A Play button for each server that has the series, the viewer's own
  // servers first.
  if (
    hasPermission([Permission.REQUEST, Permission.REQUEST_TV], {
      type: 'or',
    })
  ) {
    playLinks.forEach((link) => {
      if (link.url) {
        mediaLinks.push({
          text: intl.formatMessage(messages.play, {
            mediaServerName: link.name,
          }),
          url: link.url,
          svg: <PlayIcon />,
        });
      }
    });
  }

  if (
    settings.currentSettings.series4kEnabled &&
    hasPermission([Permission.REQUEST_4K, Permission.REQUEST_4K_TV], {
      type: 'or',
    })
  ) {
    playLinks.forEach((link) => {
      if (link.url4k) {
        mediaLinks.push({
          text: intl.formatMessage(messages.play4k, {
            mediaServerName: link.name,
          }),
          url: link.url4k,
          svg: <PlayIcon />,
        });
      }
    });
  }

  const trailerVideo = data.relatedVideos
    ?.filter((r) => r.type === 'Trailer')
    .sort((a, b) => a.size - b.size)
    .pop();
  const trailerUrl =
    trailerVideo?.site === 'YouTube' &&
    settings.currentSettings.youtubeUrl != ''
      ? `${settings.currentSettings.youtubeUrl}${trailerVideo?.key}`
      : trailerVideo?.url;

  if (trailerUrl) {
    mediaLinks.push({
      text: intl.formatMessage(messages.watchtrailer),
      url: trailerUrl,
      svg: <FilmIcon />,
    });
  }

  const discoverRegion = user?.settings?.discoverRegion
    ? user.settings.discoverRegion
    : settings.currentSettings.discoverRegion
      ? settings.currentSettings.discoverRegion
      : 'US';
  const seriesAttributes: React.ReactNode[] = [];

  const contentRating = data.contentRatings.results.find(
    (r) => r.iso_3166_1 === discoverRegion
  )?.rating;
  if (contentRating) {
    seriesAttributes.push(
      <span className="rounded-md border p-0.5 py-0">{contentRating}</span>
    );
  }

  // Does NOT include "Specials"
  const seasonCount = data.seasons.filter(
    (season) => season.seasonNumber !== 0 && season.episodeCount !== 0
  ).length;

  if (seasonCount) {
    seriesAttributes.push(
      intl.formatMessage(messages.seasons, { seasonCount: seasonCount })
    );
  }

  if (data.genres.length) {
    seriesAttributes.push(
      data.genres
        .map((g) => (
          <Link
            href={`/discover/tv?genre=${g.id}`}
            key={`genre-${g.id}`}
            className="hover:underline"
          >
            {g.name}
          </Link>
        ))
        .reduce((prev, curr) => (
          <Fragment key={`${prev.key}-${curr.key}`}>
            {intl.formatMessage(globalMessages.delimitedlist, {
              a: prev,
              b: curr,
            })}
          </Fragment>
        ))
    );
  }

  const getAllRequestedSeasons = (is4k: boolean): number[] => {
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
          ...request.seasons.map((sr) => sr.seasonNumber),
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

  // Mirrors the season list the request modal offers, so the two agree.
  const requestableSeasons = data.seasons
    .filter(
      (season) =>
        season.episodeCount !== 0 &&
        (settings.currentSettings.enableSpecialEpisodes ||
          season.seasonNumber !== 0)
    )
    .map((season) => season.seasonNumber);

  const isSeasonSetComplete = (is4k: boolean) => {
    const requested = getAllRequestedSeasons(is4k);
    return requestableSeasons.every((seasonNumber) =>
      requested.includes(seasonNumber)
    );
  };

  const isComplete = isSeasonSetComplete(false);

  const is4kComplete = isSeasonSetComplete(true);

  const streamingRegion = user?.settings?.streamingRegion
    ? user.settings.streamingRegion
    : settings.currentSettings.streamingRegion
      ? settings.currentSettings.streamingRegion
      : 'US';
  const streamingProviders =
    data?.watchProviders?.find(
      (provider) => provider.iso_3166_1 === streamingRegion
    )?.flatrate ?? [];

  const onClickWatchlistBtn = async (): Promise<void> => {
    setIsUpdating(true);

    try {
      await axios.post('/api/v1/watchlist', {
        tmdbId: tv?.id,
        mediaType: MediaType.TV,
        title: tv?.name,
      });
      addToast(
        <span>
          {intl.formatMessage(messages.watchlistSuccess, {
            title: tv?.name,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );

      setIsUpdating(false);
      setToggleWatchlist((prevState) => !prevState);
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });

      setIsUpdating(false);
    }
  };

  const onClickDeleteWatchlistBtn = async (): Promise<void> => {
    setIsUpdating(true);

    try {
      await axios.delete(
        `/api/v1/watchlist/${tv?.id}?mediaType=${MediaType.TV}`
      );

      addToast(
        <span>
          {intl.formatMessage(messages.watchlistDeleted, {
            title: tv?.name,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'info', autoDismiss: true }
      );

      setIsUpdating(false);
      setToggleWatchlist((prevState) => !prevState);
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });

      setIsUpdating(false);
    }
  };

  const onClickHideItemBtn = async (reason?: string): Promise<void> => {
    setIsBlocklistUpdating(true);

    try {
      const res = await axios.post<{
        failed?: { service: string }[];
      }>('/api/v1/blocklist', {
        tmdbId: tv?.id,
        mediaType: 'tv',
        title: tv?.name,
        user: user?.id,
        reason,
        removeFiles: blocklist.removesFiles,
      });

      if (res.status === 201) {
        addToast(
          <span>
            {intl.formatMessage(globalMessages.blocklistSuccess, {
              title: tv?.name,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );

        // Blocklisted, but a Radarr/Sonarr removal did not go through.
        const failed = res.data?.failed ?? [];
        if (failed.length) {
          addToast(
            intl.formatMessage(globalMessages.blocklistRemovalFailed, {
              services: failed.map((f) => f.service).join(', '),
            }),
            { appearance: 'warning', autoDismiss: false }
          );
        }

        revalidate();
      }
    } catch (e) {
      if (e?.response?.status === 412) {
        addToast(
          <span>
            {intl.formatMessage(globalMessages.blocklistDuplicateError, {
              title: tv?.name,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'info', autoDismiss: true }
        );
      } else {
        addToast(intl.formatMessage(globalMessages.blocklistError), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    }

    setIsBlocklistUpdating(false);
    closeBlocklistModal();
  };

  const showHideButton = hasPermission([Permission.MANAGE_BLOCKLIST], {
    type: 'or',
  });

  const blocklist = blocklistAction(data?.mediaInfo?.status, {
    canManageBlocklist: showHideButton,
    isAdmin: hasPermission(Permission.ADMIN),
  });

  /*
   * Which seasons the per-season and per-episode Request buttons appear on.
   * The same rule the server applies when creating a request: a season with
   * any status (partly available, available, processing) or in any request
   * that is not declined or completed is taken, and would be dropped from a
   * new one. Offering a button there would look like it worked and do
   * nothing. Never for a blocklisted title, and not at all while partial
   * requests are off: a request is then for every season still wanted.
   */
  const takenSeasons = new Set<number>([
    ...(data.mediaInfo?.requests ?? [])
      .filter(
        (r) =>
          !r.is4k &&
          r.status !== MediaRequestStatus.DECLINED &&
          r.status !== MediaRequestStatus.COMPLETED
      )
      .flatMap((r) => r.seasons.map((s) => s.seasonNumber)),
    ...(data.mediaInfo?.seasons ?? [])
      .filter(
        (s) =>
          s.status !== MediaStatus.UNKNOWN && s.status !== MediaStatus.DELETED
      )
      .map((s) => s.seasonNumber),
  ]);
  const seasonRequestable = (seasonNumber: number) =>
    settings.currentSettings.partialRequestsEnabled &&
    data.mediaInfo?.status !== MediaStatus.BLOCKLISTED &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_TV], {
      type: 'or',
    }) &&
    !takenSeasons.has(seasonNumber);

  return (
    <div
      className="media-page"
      style={{
        height: 493,
      }}
    >
      {data.backdropPath && (
        <div className="media-page-bg-image">
          <CachedImage
            type="tmdb"
            alt=""
            src={titleBackdrop(data.backdropPath)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            fill
            priority
          />
          <div className="media-page-fade" />
        </div>
      )}
      <PageTitle title={data.name} />
      <BlocklistModal
        tmdbId={data.id}
        type="tv"
        show={showBlocklistModal}
        onCancel={closeBlocklistModal}
        onComplete={onClickHideItemBtn}
        isUpdating={isBlocklistUpdating}
        removesFiles={blocklist.removesFiles}
      />
      <IssueModal
        onCancel={() => setShowIssueModal(false)}
        show={showIssueModal}
        mediaType="tv"
        tmdbId={data.id}
      />
      {requestFor && (
        <RequestModal
          key={`request-${requestFor.seasonNumber}-${requestFor.episodeNumber ?? 'season'}`}
          tmdbId={data.id}
          show
          type="tv"
          preselect={requestFor}
          onComplete={() => {
            revalidate();
            // The episode list shows what is requested; refresh it too.
            mutateCache(
              `/api/v1/tv/${data.id}/season/${requestFor.seasonNumber}`
            );
            setRequestFor(null);
          }}
          onCancel={() => setRequestFor(null)}
        />
      )}
      <RequestModal
        tmdbId={data.id}
        show={showRequestModal}
        type="tv"
        onComplete={() => {
          revalidate();
          setShowRequestModal(false);
        }}
        onCancel={() => setShowRequestModal(false)}
      />
      <ManageSlideOver
        data={data}
        mediaType="tv"
        onClose={() => {
          setShowManager(false);
          router.replace({
            pathname: router.pathname,
            query: { tvId: router.query.tvId },
          });
        }}
        revalidate={() => revalidate()}
        show={showManager}
      />
      <div className="media-header" data-seerr="title-header">
        <div className="media-poster" data-seerr="poster">
          <CachedImage
            type="tmdb"
            src={
              data.posterPath
                ? titlePoster(data.posterPath)
                : '/images/seerr_poster_not_found.png'
            }
            alt=""
            sizes="100vw"
            style={{ width: '100%', height: 'auto' }}
            width={600}
            height={900}
            priority
          />
        </div>
        <div className="media-title">
          <div className="media-status">
            <DeletingSoonBadge tmdbId={data.id} mediaType="tv" />
            <StatusBadge
              status={data.mediaInfo?.status}
              downloadItem={data.mediaInfo?.downloadStatus}
              title={data.name}
              inProgress={(data.mediaInfo?.downloadStatus ?? []).length > 0}
              tmdbId={data.mediaInfo?.tmdbId}
              mediaType="tv"
              playLink={playLink}
              serviceUrl={data.mediaInfo?.serviceUrl}
            />
            {settings.currentSettings.series4kEnabled &&
              hasPermission(
                [
                  Permission.MANAGE_REQUESTS,
                  Permission.REQUEST_4K,
                  Permission.REQUEST_4K_TV,
                ],
                {
                  type: 'or',
                }
              ) && (
                <StatusBadge
                  status={data.mediaInfo?.status4k}
                  downloadItem={data.mediaInfo?.downloadStatus4k}
                  title={data.name}
                  is4k
                  inProgress={
                    (data.mediaInfo?.downloadStatus4k ?? []).length > 0
                  }
                  tmdbId={data.mediaInfo?.tmdbId}
                  mediaType="tv"
                  playLink={playLink4k}
                  serviceUrl={data.mediaInfo?.serviceUrl4k}
                />
              )}
          </div>
          <h1 data-testid="media-title">
            {data.name}{' '}
            {data.firstAirDate && (
              <span className="media-year">
                ({data.firstAirDate.slice(0, 4)})
              </span>
            )}
          </h1>
          <span className="media-attributes">
            {seriesAttributes.length > 0 &&
              seriesAttributes
                .map((t, k) => <span key={k}>{t}</span>)
                .reduce((prev, curr) => (
                  <Fragment key={`${prev.key}-${curr.key}`}>
                    {prev}
                    <span>|</span>
                    {curr}
                  </Fragment>
                ))}
          </span>
          <TitleEta
            requests={data.mediaInfo?.requests}
            media={data.mediaInfo}
          />
          <TitleDeclineReason requests={data.mediaInfo?.requests} />
        </div>
        <div className="media-actions">
          {blocklist.show && (
            <Tooltip
              content={intl.formatMessage(globalMessages.addToBlocklist)}
            >
              <Button
                buttonType={'ghost'}
                className="media-action-icon z-40"
                buttonSize={'md'}
                onClick={() => setShowBlocklistModal(true)}
              >
                <EyeSlashIcon />
              </Button>
            </Tooltip>
          )}
          {data?.mediaInfo?.status !== MediaStatus.BLOCKLISTED &&
            // Someone with Plex keeps their watchlist on Plex.
            !hasAccountOn(user, 'plex') && (
              <>
                {toggleWatchlist ? (
                  <Tooltip
                    content={intl.formatMessage(messages.addtowatchlist)}
                  >
                    <Button
                      buttonType={'ghost'}
                      className="media-action-icon z-40"
                      buttonSize={'md'}
                      onClick={onClickWatchlistBtn}
                    >
                      {isUpdating ? (
                        <Spinner />
                      ) : (
                        <StarIcon
                          className={'text-amber-300 light:text-amber-600'}
                        />
                      )}
                    </Button>
                  </Tooltip>
                ) : (
                  <Tooltip
                    content={intl.formatMessage(messages.removefromwatchlist)}
                  >
                    <Button
                      className="media-action-icon z-40"
                      buttonSize={'md'}
                      onClick={onClickDeleteWatchlistBtn}
                    >
                      {isUpdating ? <Spinner /> : <MinusCircleIcon />}
                    </Button>
                  </Tooltip>
                )}
              </>
            )}
          <div className="media-action-wide z-20">
            <PlayButton links={mediaLinks} />
          </div>
          <div className="z-20">
            <AddToList mediaType="tv" tmdbId={data.id} />
          </div>
          <KeepButton tmdbId={data.id} mediaType="tv" title={data.name} />
          <FutureSeasonsButton
            tmdbId={data.id}
            title={data.name}
            seriesStatus={data.status}
          />
          <CatchMeUp tmdbId={data.id} seasons={data.seasons ?? []} />
          <div className="media-action-wide">
            <RequestButton
              mediaType="tv"
              onUpdate={() => revalidate()}
              tmdbId={data?.id}
              media={data?.mediaInfo}
              isShowComplete={isComplete}
              is4kShowComplete={is4kComplete}
            />
          </div>
          {(data.mediaInfo?.status === MediaStatus.AVAILABLE ||
            data.mediaInfo?.status === MediaStatus.PARTIALLY_AVAILABLE ||
            (settings.currentSettings.series4kEnabled &&
              hasPermission([Permission.REQUEST_4K, Permission.REQUEST_4K_TV], {
                type: 'or',
              }) &&
              (data.mediaInfo?.status4k === MediaStatus.AVAILABLE ||
                data?.mediaInfo?.status4k ===
                  MediaStatus.PARTIALLY_AVAILABLE))) &&
            hasPermission(
              [Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES],
              {
                type: 'or',
              }
            ) && (
              <Tooltip content={intl.formatMessage(messages.reportissue)}>
                <Button
                  buttonType="warning"
                  className="media-action-icon"
                  onClick={() => setShowIssueModal(true)}
                >
                  <ExclamationTriangleIcon />
                </Button>
              </Tooltip>
            )}
          {hasPermission(Permission.ADMIN) &&
            data.mediaInfo?.externalServiceId != null &&
            data.mediaInfo.serviceId != null && (
              <BackfillTitleButton
                tmdbId={data.id}
                target={{
                  kind: 'series',
                  serverId: data.mediaInfo.serviceId,
                  arrId: data.mediaInfo.externalServiceId,
                  title: data.name,
                }}
              />
            )}
          {hasPermission(Permission.MANAGE_REQUESTS) && data.mediaInfo && (
            <Tooltip content={intl.formatMessage(messages.manageseries)}>
              <Button
                buttonType="ghost"
                onClick={() => setShowManager(true)}
                className="media-action-icon relative"
              >
                <CogIcon className="!mr-0" />
                {hasPermission(
                  [Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES],
                  {
                    type: 'or',
                  }
                ) &&
                  (
                    data.mediaInfo?.issues.filter(
                      (issue) => issue.status === IssueStatus.OPEN
                    ) ?? []
                  ).length > 0 && (
                    <>
                      <div className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-red-600" />
                      <div className="absolute -right-1 -top-1 h-3 w-3 animate-ping rounded-full bg-red-600" />
                    </>
                  )}
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="media-overview">
        <div className="media-overview-left">
          {data.tagline && <div className="tagline">{data.tagline}</div>}
          <h2>{intl.formatMessage(messages.overview)}</h2>
          <p>
            {data.overview
              ? data.overview
              : intl.formatMessage(messages.overviewunavailable)}
          </p>
          {sortedCrew.length > 0 && (
            <>
              <ul className="media-crew">
                {(data.createdBy.length > 0
                  ? [
                      ...data.createdBy.map(
                        (person): Partial<Crew> => ({
                          id: person.id,
                          job: 'Creator',
                          name: person.name,
                        })
                      ),
                      ...sortedCrew,
                    ]
                  : sortedCrew
                )
                  .slice(0, 6)
                  .map((person) => (
                    <li key={`crew-${person.job}-${person.id}`}>
                      <span>{person.job}</span>
                      <Link href={`/person/${person.id}`} className="crew-name">
                        {person.name}
                      </Link>
                    </li>
                  ))}
              </ul>
              <div className="mt-4 flex justify-end">
                <Link
                  href={`/tv/${data.id}/crew`}
                  className="flex items-center text-muted transition duration-300 hover:text-gray-100"
                >
                  <span>{intl.formatMessage(messages.viewfullcrew)}</span>
                  <ArrowRightCircleIcon className="ml-1.5 inline-block h-5 w-5" />
                </Link>
              </div>
            </>
          )}
          {data.keywords.length > 0 && (
            <div className="mt-6">
              {data.keywords.map((keyword) => (
                <Link
                  href={`/discover/tv?keywords=${keyword.id}`}
                  key={`keyword-id-${keyword.id}`}
                  className="mb-2 mr-2 inline-flex last:mr-0"
                >
                  <Tag>{keyword.name}</Tag>
                </Link>
              ))}
            </div>
          )}
          <h2 id="seasons" className="scroll-mt-20 py-4">
            {intl.formatMessage(messages.seasonstitle)}
          </h2>
          <div className="flex w-full flex-col space-y-2">
            {data.seasons
              .slice()
              .reverse()
              .filter(
                (season) =>
                  settings.currentSettings.enableSpecialEpisodes ||
                  season.seasonNumber !== 0
              )
              .map((season) => {
                const show4k =
                  settings.currentSettings.series4kEnabled &&
                  hasPermission(
                    [
                      Permission.MANAGE_REQUESTS,
                      Permission.REQUEST_4K,
                      Permission.REQUEST_4K_TV,
                    ],
                    {
                      type: 'or',
                    }
                  );
                const mSeason = (data.mediaInfo?.seasons ?? []).find(
                  (s) =>
                    season.seasonNumber === s.seasonNumber &&
                    s.status !== MediaStatus.UNKNOWN
                );
                const mSeason4k = (data.mediaInfo?.seasons ?? []).find(
                  (s) =>
                    season.seasonNumber === s.seasonNumber &&
                    s.status4k !== MediaStatus.UNKNOWN
                );
                const request = (data.mediaInfo?.requests ?? [])
                  .filter(
                    (r) =>
                      !!r.seasons.find(
                        (s) => s.seasonNumber === season.seasonNumber
                      ) && !r.is4k
                  )
                  .sort(
                    (a, b) =>
                      new Date(b.createdAt).getTime() -
                      new Date(a.createdAt).getTime()
                  )[0];
                const request4k = (data.mediaInfo?.requests ?? [])
                  .filter(
                    (r) =>
                      !!r.seasons.find(
                        (s) => s.seasonNumber === season.seasonNumber
                      ) && r.is4k
                  )
                  .sort(
                    (a, b) =>
                      new Date(b.createdAt).getTime() -
                      new Date(a.createdAt).getTime()
                  )[0];

                if (season.episodeCount === 0) {
                  return null;
                }

                return (
                  <Disclosure key={`season-discoslure-${season.seasonNumber}`}>
                    {({ open }) => (
                      <>
                        <DisclosureButton
                          className={`mt-2 flex w-full items-center justify-between space-x-2 border-subtle bg-surface px-4 py-2 text-gray-200 ${
                            open
                              ? 'rounded-t-md border-l border-r border-t'
                              : 'rounded-md border'
                          }`}
                        >
                          <div className="flex flex-1 items-center space-x-2 text-lg">
                            <span>
                              {season.seasonNumber === 0
                                ? intl.formatMessage(globalMessages.specials)
                                : intl.formatMessage(messages.seasonnumber, {
                                    seasonNumber: season.seasonNumber,
                                  })}
                            </span>
                            <Badge badgeType="dark">
                              {intl.formatMessage(messages.episodeCount, {
                                episodeCount: season.episodeCount,
                              })}
                            </Badge>
                            <SeasonSubtitleBadge
                              tvId={data.id}
                              seasonNumber={season.seasonNumber}
                            />
                          </div>
                          {((!mSeason &&
                            request?.status === MediaRequestStatus.APPROVED) ||
                            mSeason?.status === MediaStatus.PROCESSING ||
                            (request?.status === MediaRequestStatus.APPROVED &&
                              mSeason?.status === MediaStatus.DELETED)) && (
                            <>
                              <div className="hidden md:flex">
                                <Badge badgeType="primary">
                                  {intl.formatMessage(globalMessages.requested)}
                                </Badge>
                              </div>
                              <div className="flex md:hidden">
                                <StatusBadgeMini
                                  status={MediaStatus.PROCESSING}
                                />
                              </div>
                            </>
                          )}
                          {((!mSeason &&
                            request?.status === MediaRequestStatus.PENDING) ||
                            mSeason?.status === MediaStatus.PENDING) && (
                            <>
                              <div className="hidden md:flex">
                                <Badge badgeType="warning">
                                  {intl.formatMessage(globalMessages.pending)}
                                </Badge>
                              </div>
                              <div className="flex md:hidden">
                                <StatusBadgeMini status={MediaStatus.PENDING} />
                              </div>
                            </>
                          )}
                          {mSeason?.status ===
                            MediaStatus.PARTIALLY_AVAILABLE && (
                            <>
                              <div className="hidden md:flex">
                                <Badge badgeType="success">
                                  {intl.formatMessage(
                                    globalMessages.partiallyavailable
                                  )}
                                </Badge>
                              </div>
                              <div className="flex md:hidden">
                                <StatusBadgeMini
                                  status={MediaStatus.PARTIALLY_AVAILABLE}
                                />
                              </div>
                            </>
                          )}
                          {mSeason?.status === MediaStatus.AVAILABLE && (
                            <>
                              <div className="hidden md:flex">
                                <Badge badgeType="success">
                                  {intl.formatMessage(globalMessages.available)}
                                </Badge>
                              </div>
                              <div className="flex md:hidden">
                                <StatusBadgeMini
                                  status={MediaStatus.AVAILABLE}
                                />
                              </div>
                            </>
                          )}
                          {mSeason?.status === MediaStatus.DELETED &&
                            request?.status !== MediaRequestStatus.APPROVED && (
                              <>
                                <div className="hidden md:flex">
                                  <Badge badgeType="danger">
                                    {intl.formatMessage(globalMessages.deleted)}
                                  </Badge>
                                </div>
                                <div className="flex md:hidden">
                                  <StatusBadgeMini
                                    status={MediaStatus.DELETED}
                                  />
                                </div>
                              </>
                            )}
                          {((!mSeason4k &&
                            request4k?.status ===
                              MediaRequestStatus.APPROVED) ||
                            mSeason4k?.status4k === MediaStatus.PROCESSING ||
                            (request4k?.status ===
                              MediaRequestStatus.APPROVED &&
                              mSeason4k?.status4k === MediaStatus.DELETED)) &&
                            show4k && (
                              <>
                                <div className="hidden md:flex">
                                  <Badge badgeType="primary">
                                    {intl.formatMessage(messages.status4k, {
                                      status: intl.formatMessage(
                                        globalMessages.requested
                                      ),
                                    })}
                                  </Badge>
                                </div>
                                <div className="flex md:hidden">
                                  <StatusBadgeMini
                                    status={MediaStatus.PROCESSING}
                                    is4k={true}
                                  />
                                </div>
                              </>
                            )}
                          {((!mSeason4k &&
                            request4k?.status === MediaRequestStatus.PENDING) ||
                            mSeason?.status4k === MediaStatus.PENDING) &&
                            show4k && (
                              <>
                                <div className="hidden md:flex">
                                  <Badge badgeType="warning">
                                    {intl.formatMessage(messages.status4k, {
                                      status: intl.formatMessage(
                                        globalMessages.pending
                                      ),
                                    })}
                                  </Badge>
                                </div>
                                <div className="flex md:hidden">
                                  <StatusBadgeMini
                                    status={MediaStatus.PENDING}
                                    is4k={true}
                                  />
                                </div>
                              </>
                            )}
                          {mSeason4k?.status4k ===
                            MediaStatus.PARTIALLY_AVAILABLE &&
                            show4k && (
                              <>
                                <div className="hidden md:flex">
                                  <Badge badgeType="success">
                                    {intl.formatMessage(messages.status4k, {
                                      status: intl.formatMessage(
                                        globalMessages.partiallyavailable
                                      ),
                                    })}
                                  </Badge>
                                </div>
                                <div className="flex md:hidden">
                                  <StatusBadgeMini
                                    status={MediaStatus.PARTIALLY_AVAILABLE}
                                    is4k={true}
                                  />
                                </div>
                              </>
                            )}
                          {mSeason4k?.status4k === MediaStatus.AVAILABLE &&
                            show4k && (
                              <>
                                <div className="hidden md:flex">
                                  <Badge badgeType="success">
                                    {intl.formatMessage(messages.status4k, {
                                      status: intl.formatMessage(
                                        globalMessages.available
                                      ),
                                    })}
                                  </Badge>
                                </div>
                                <div className="flex md:hidden">
                                  <StatusBadgeMini
                                    status={MediaStatus.AVAILABLE}
                                    is4k={true}
                                  />
                                </div>
                              </>
                            )}
                          {mSeason4k?.status4k === MediaStatus.DELETED &&
                            request4k?.status !== MediaRequestStatus.APPROVED &&
                            show4k && (
                              <>
                                <div className="hidden md:flex">
                                  <Badge badgeType="danger">
                                    {intl.formatMessage(messages.status4k, {
                                      status: intl.formatMessage(
                                        globalMessages.deleted
                                      ),
                                    })}
                                  </Badge>
                                </div>
                                <div className="flex md:hidden">
                                  <StatusBadgeMini
                                    status={MediaStatus.DELETED}
                                    is4k={true}
                                  />
                                </div>
                              </>
                            )}
                          <ChevronDownIcon
                            className={`${
                              open ? 'rotate-180' : ''
                            } h-6 w-6 text-gray-500`}
                          />
                        </DisclosureButton>
                        <Transition
                          as="div"
                          show={open}
                          enter="transition-opacity duration-100 ease-out"
                          enterFrom="opacity-0"
                          enterTo="opacity-100"
                          leave="transition-opacity duration-75 ease-out"
                          leaveFrom="opacity-100"
                          leaveTo="opacity-0"
                          // Not sure why this transition is adding a margin without this here
                          style={{ margin: '0px' }}
                        >
                          <DisclosurePanel className="w-full rounded-b-md border-b border-l border-r border-subtle px-4 pb-2">
                            <Season
                              tvId={data.id}
                              seasonNumber={season.seasonNumber}
                              onRequestSeason={
                                seasonRequestable(season.seasonNumber)
                                  ? () =>
                                      setRequestFor({
                                        seasonNumber: season.seasonNumber,
                                      })
                                  : undefined
                              }
                              onRequestEpisode={
                                seasonRequestable(season.seasonNumber)
                                  ? (episodeNumber) =>
                                      setRequestFor({
                                        seasonNumber: season.seasonNumber,
                                        episodeNumber,
                                      })
                                  : undefined
                              }
                            />
                          </DisclosurePanel>
                        </Transition>
                      </>
                    )}
                  </Disclosure>
                );
              })}
          </div>
        </div>
        <div className="media-overview-right">
          {hasPermission(Permission.ADMIN) &&
            settings.currentSettings.mediaServerType !==
              MediaServerType.NOT_CONFIGURED &&
            data.mediaInfo && (
              <PlexMatchWarning
                mediaType="tv"
                tmdbId={data.id}
                tvdbId={data.mediaInfo.tvdbId}
                itemKey={
                  data.mediaInfo.ratingKey ??
                  data.mediaInfo.jellyfinMediaId ??
                  data.mediaInfo.embyMediaId
                }
              />
            )}
          {hasPermission(Permission.ADMIN) &&
            data.mediaInfo?.externalServiceId != null &&
            data.mediaInfo.serviceId != null && (
              <BackfillForTitle
                tmdbId={data.id}
                target={{
                  kind: 'series',
                  serverId: data.mediaInfo.serviceId,
                  arrId: data.mediaInfo.externalServiceId,
                }}
              />
            )}
          <div className="media-facts">
            {(!!data.voteCount ||
              (ratingData?.criticsRating && !!ratingData?.criticsScore) ||
              (ratingData?.audienceRating && !!ratingData?.audienceScore) ||
              !!imdbRating?.criticsScore) && (
              <div className="media-ratings">
                {ratingData?.criticsRating && !!ratingData?.criticsScore && (
                  <Tooltip
                    content={intl.formatMessage(messages.rtcriticsscore)}
                  >
                    <a
                      href={ratingData.url}
                      className="media-rating"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {ratingData.criticsRating === 'Rotten' ? (
                        <RTRotten className="mr-1 w-6" />
                      ) : (
                        <RTFresh className="mr-1 w-6" />
                      )}
                      <span>{ratingData.criticsScore}%</span>
                    </a>
                  </Tooltip>
                )}
                {ratingData?.audienceRating && !!ratingData?.audienceScore && (
                  <Tooltip
                    content={intl.formatMessage(messages.rtaudiencescore)}
                  >
                    <a
                      href={ratingData.url}
                      className="media-rating"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {ratingData.audienceRating === 'Spilled' ? (
                        <RTAudRotten className="mr-1 w-6" />
                      ) : (
                        <RTAudFresh className="mr-1 w-6" />
                      )}
                      <span>{ratingData.audienceScore}%</span>
                    </a>
                  </Tooltip>
                )}
                {!!imdbRating?.criticsScore && (
                  <Tooltip
                    content={intl.formatMessage(messages.imdbuserscore, {
                      formattedCount: intl.formatNumber(
                        imdbRating.criticsScoreCount,
                        {
                          notation: 'compact',
                          compactDisplay: 'short',
                          maximumFractionDigits: 1,
                        }
                      ),
                    })}
                  >
                    <a
                      href={imdbRating.url}
                      className="media-rating"
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ImdbLogo className="mr-1 w-6" />
                      <span>
                        {intl.formatNumber(imdbRating.criticsScore, {
                          minimumFractionDigits: 1,
                          maximumFractionDigits: 1,
                        })}
                      </span>
                    </a>
                  </Tooltip>
                )}
                {!!data.voteCount && (
                  <Tooltip content={intl.formatMessage(messages.tmdbuserscore)}>
                    <a
                      href={`https://www.themoviedb.org/tv/${data.id}?language=${locale}`}
                      className="media-rating"
                      target="_blank"
                      rel="noreferrer"
                    >
                      <TmdbLogo className="mr-1 w-6" />
                      <span>{Math.round(data.voteAverage * 10)}%</span>
                    </a>
                  </Tooltip>
                )}
              </div>
            )}
            {data.originalName &&
              data.originalLanguage !== locale.slice(0, 2) && (
                <div className="media-fact">
                  <span>{intl.formatMessage(messages.originaltitle)}</span>
                  <span className="media-fact-value">{data.originalName}</span>
                </div>
              )}
            {(data.mediaInfo?.animeSetting ?? isAnime(data)) && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.showtype)}</span>
                <span className="media-fact-value">
                  {intl.formatMessage(messages.anime)}
                </span>
              </div>
            )}
            <div className="media-fact">
              <span>{intl.formatMessage(globalMessages.status)}</span>
              <span className="media-fact-value">{data.status}</span>
            </div>
            <RequestedBy requests={data.mediaInfo?.requests} />
            <WatchedBy mediaId={data.mediaInfo?.id} isShow={true} />
            {data.firstAirDate && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.firstAirDate)}</span>
                <span className="media-fact-value">
                  {intl.formatDate(data.firstAirDate, {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    timeZone: 'UTC',
                  })}
                </span>
              </div>
            )}
            {data.nextEpisodeToAir &&
              data.nextEpisodeToAir.airDate &&
              data.nextEpisodeToAir.airDate !== data.firstAirDate && (
                <div className="media-fact">
                  <span>{intl.formatMessage(messages.nextAirDate)}</span>
                  <span className="media-fact-value">
                    {intl.formatDate(data.nextEpisodeToAir.airDate, {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </span>
                </div>
              )}
            {data.episodeRunTime.length > 0 && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.episodeRuntime)}</span>
                <span className="media-fact-value">
                  {intl.formatMessage(messages.episodeRuntimeMinutes, {
                    runtime: data.episodeRunTime[0],
                  })}
                </span>
              </div>
            )}
            {data.originalLanguage && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.originallanguage)}</span>
                <span className="media-fact-value">
                  <Link href={`/discover/tv/language/${data.originalLanguage}`}>
                    {intl.formatDisplayName(data.originalLanguage, {
                      type: 'language',
                      fallback: 'none',
                    }) ??
                      data.spokenLanguages.find(
                        (lng) => lng.iso_639_1 === data.originalLanguage
                      )?.name}
                  </Link>
                </span>
              </div>
            )}
            {data.productionCountries.length > 0 && (
              <div className="media-fact">
                <span>
                  {intl.formatMessage(messages.productioncountries, {
                    countryCount: data.productionCountries.length,
                  })}
                </span>
                <span className="media-fact-value">
                  {data.productionCountries.map((c) => {
                    return (
                      <span
                        className="flex items-center justify-end"
                        key={`prodcountry-${c.iso_3166_1}`}
                      >
                        <Flag
                          className="mr-1.5 text-xs leading-5"
                          code={c.iso_3166_1}
                        />
                        <span>
                          {intl.formatDisplayName(c.iso_3166_1, {
                            type: 'region',
                            fallback: 'none',
                          }) ?? c.name}
                        </span>
                      </span>
                    );
                  })}
                </span>
              </div>
            )}
            {data.networks.length > 0 && (
              <div className="media-fact">
                <span>
                  {intl.formatMessage(messages.network, {
                    networkCount: data.networks.length,
                  })}
                </span>
                <span className="media-fact-value">
                  {data.networks
                    .map((n) => (
                      <Link
                        href={`/discover/tv/network/${n.id}`}
                        key={`network-${n.id}`}
                      >
                        {n.name}
                      </Link>
                    ))
                    .reduce((prev, curr) => (
                      <Fragment key={`${prev.key}-${curr.key}`}>
                        {intl.formatMessage(globalMessages.delimitedlist, {
                          a: prev,
                          b: curr,
                        })}
                      </Fragment>
                    ))}
                </span>
              </div>
            )}
            {!!streamingProviders.length && (
              <div className="media-fact flex-col gap-1">
                <span>{intl.formatMessage(messages.streamingproviders)}</span>
                <span className="media-fact-value flex flex-row flex-wrap gap-5">
                  {streamingProviders.map((p) => {
                    return (
                      <Tooltip content={p.name} key={`tooltip-${p.id}`}>
                        <span
                          className="opacity-50 transition duration-300 hover:opacity-100"
                          key={`provider-${p.id}`}
                        >
                          <CachedImage
                            type="tmdb"
                            src={'https://image.tmdb.org/t/p/w45/' + p.logoPath}
                            alt={p.name}
                            width={32}
                            height={32}
                            className="rounded-md"
                          />
                        </span>
                      </Tooltip>
                    );
                  })}
                </span>
              </div>
            )}
            <div className="media-fact">
              <ExternalLinkBlock
                mediaType="tv"
                tmdbId={data.id}
                tvdbId={data.externalIds.tvdbId}
                imdbId={data.externalIds.imdbId}
                rtUrl={ratingData?.url}
                playLinks={playLinks}
              />
            </div>
          </div>
          <SubtitlesCard
            kind="tv"
            tmdbId={data.id}
            title={`${data.name}${data.firstAirDate ? ` (${data.firstAirDate.slice(0, 4)})` : ''}`}
          />
        </div>
      </div>
      {data.credits.cast.length > 0 && (
        <>
          <div className="slider-header">
            <Link
              href="/tv/[tvId]/cast"
              as={`/tv/${data.id}/cast`}
              className="slider-title"
            >
              <span>{intl.formatMessage(messages.cast)}</span>
              <ArrowRightCircleIcon />
            </Link>
          </div>
          <Slider
            sliderKey="cast"
            isLoading={false}
            isEmpty={false}
            items={data.credits.cast.slice(0, 20).map((person) => (
              <PersonCard
                key={`cast-item-${person.id}`}
                personId={person.id}
                name={person.name}
                subName={person.character}
                profilePath={person.profilePath}
              />
            ))}
          />
        </>
      )}
      <MediaSlider
        sliderKey="recommendations"
        title={intl.formatMessage(messages.recommendations)}
        url={`/api/v1/tv/${router.query.tvId}/recommendations`}
        linkUrl={`/tv/${data.id}/recommendations`}
        hideWhenEmpty
      />
      <MediaSlider
        sliderKey="similar"
        title={intl.formatMessage(messages.similar)}
        url={`/api/v1/tv/${router.query.tvId}/similar`}
        linkUrl={`/tv/${data.id}/similar`}
        hideWhenEmpty
      />
      <div className="extra-bottom-space relative" />
    </div>
  );
};

export default TvDetails;
