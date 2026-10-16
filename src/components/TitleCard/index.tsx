import AddToList from '@app/components/AddToList';
import BlocklistModal from '@app/components/BlocklistModal';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import StatusBadgeMini from '@app/components/Common/StatusBadgeMini';
import Tooltip from '@app/components/Common/Tooltip';
import { DeletingSoonMarker, KeepButton } from '@app/components/DeletingSoon';
import RequestModal from '@app/components/RequestModal';
import CardShell, { useCardDetail } from '@app/components/TitleCard/CardShell';
import ErrorCard from '@app/components/TitleCard/ErrorCard';
import Placeholder from '@app/components/TitleCard/Placeholder';
import useMediaMarkers, { MARKERS_KEY } from '@app/hooks/useMediaMarkers';
import useSettings from '@app/hooks/useSettings';
import { announceTitleChanged } from '@app/hooks/useTitleChanged';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  preloadPicture,
  titleBackdrop,
  titlePoster,
  tmdbImageSrc,
} from '@app/utils/imageSources';
import { hasAccountOn } from '@app/utils/mediaServerAccounts';
import { withProperties } from '@app/utils/typeHelpers';
import {
  ArrowDownTrayIcon,
  EyeIcon,
  EyeSlashIcon,
  MinusCircleIcon,
  StarIcon,
} from '@heroicons/react/24/outline';
import {
  BellAlertIcon,
  BookmarkIcon as BookmarkFilledIcon,
} from '@heroicons/react/24/solid';
import { MediaStatus } from '@server/constants/media';
import type { Watchlist } from '@server/entity/Watchlist';
import type { MediaType } from '@server/models/Search';
import axios from 'axios';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useSWRConfig } from 'swr';

interface TitleCardProps {
  id: number;
  image?: string;
  /** The title's backdrop, fetched ahead as its page is opened. */
  backdrop?: string;
  summary?: string;
  year?: string;
  title: string;
  userScore?: number;
  mediaType: MediaType;
  status?: MediaStatus;
  canExpand?: boolean;
  inProgress?: boolean;
  isAddedToWatchlist?: number | boolean;
  /** Replaces the request button with custom controls in the same slot. */
  actionSlot?: React.ReactNode;
  /** Shows the compact add-to-list control beside the main action. */
  showListButton?: boolean;
  mutateParent?: () => void;
}

const messages = defineMessages('components.TitleCard', {
  addToWatchList: 'Add to watchlist',
  removeFromWatchList: 'Remove from watchlist',
  watchlistSuccess:
    '<strong>{title}</strong> added to watchlist  successfully!',
  watchlistDeleted:
    '<strong>{title}</strong> Removed from watchlist  successfully!',
  watchlistCancel: 'watchlist for <strong>{title}</strong> canceled.',
  watchlistError: 'Something went wrong. Please try again.',
});

const TitleCard = ({
  id,
  image,
  backdrop,
  summary,
  year,
  title,
  status,
  mediaType,
  isAddedToWatchlist = false,
  actionSlot,
  showListButton = true,
  inProgress = false,
  canExpand = false,
  mutateParent,
}: TitleCardProps) => {
  const intl = useIntl();
  const { mutate: globalMutate } = useSWRConfig();
  const { isOnList, isNotified } = useMediaMarkers();
  const onList = mediaType !== 'person' && isOnList(id, mediaType);
  const notified = mediaType !== 'person' && isNotified(id, mediaType);
  const { user, hasPermission } = useUser();
  const { currentSettings } = useSettings();
  const [isUpdating, setIsUpdating] = useState(false);
  const [currentStatus, setCurrentStatus] = useState(status);
  const detail = useCardDetail();
  const { showDetail } = detail;
  const [showRequestModal, setShowRequestModal] = useState(false);
  const { addToast } = useToasts();
  const [toggleWatchlist, setToggleWatchlist] =
    useState<boolean>(!isAddedToWatchlist);
  const [showBlocklistModal, setShowBlocklistModal] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // The pictures at the top of the title's page start loading as it is
  // opened, alongside the page itself rather than once it has arrived.
  const preloadPage = () => {
    if (backdrop) {
      preloadPicture(
        tmdbImageSrc(titleBackdrop(backdrop), currentSettings.cacheImages)
      );
    }
    if (image) {
      preloadPicture(
        tmdbImageSrc(titlePoster(image), currentSettings.cacheImages)
      );
    }
  };

  // Just to get the year from the date
  if (year) {
    year = year.slice(0, 4);
  }

  useEffect(() => {
    setCurrentStatus(status);
  }, [status]);

  const requestComplete = useCallback(
    (newStatus: MediaStatus) => {
      setCurrentStatus(newStatus);
      setShowRequestModal(false);

      // The card's status prop comes from the discover/search response, and
      // an effect above syncs it. Without refreshing that data the next
      // re-render resets the card — the request button reappears and the
      // pending badge never shows, even though the request went through.
      globalMutate(
        (key: unknown) =>
          typeof key === 'string' &&
          (key.startsWith('/api/v1/discover') ||
            key.startsWith('/api/v1/search') ||
            key.startsWith('/api/v1/media'))
      );
      globalMutate(MARKERS_KEY);
      // Rows loaded page by page are not reached by the refresh above.
      if (mediaType === 'movie' || mediaType === 'tv') {
        announceTitleChanged({ tmdbId: id, mediaType });
      }
    },
    [globalMutate, id, mediaType]
  );

  const requestUpdating = useCallback(
    (status: boolean) => setIsUpdating(status),
    []
  );

  const closeBlocklistModal = useCallback(
    () => setShowBlocklistModal(false),
    []
  );

  const onClickWatchlistBtn = async (): Promise<void> => {
    setIsUpdating(true);
    try {
      const response = await axios.post<Watchlist>('/api/v1/watchlist', {
        tmdbId: id,
        mediaType,
        title,
      });
      globalMutate('/api/v1/discover/watchlist');
      if (response.data) {
        addToast(
          <span>
            {intl.formatMessage(messages.watchlistSuccess, {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
      }
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
      setToggleWatchlist((prevState) => !prevState);
    }
  };

  const onClickDeleteWatchlistBtn = async (): Promise<void> => {
    setIsUpdating(true);
    try {
      const response = await axios.delete<Watchlist>(
        `/api/v1/watchlist/${id}?mediaType=${mediaType}`
      );

      if (response.status === 204) {
        addToast(
          <span>
            {intl.formatMessage(messages.watchlistDeleted, {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'info', autoDismiss: true }
        );
      }
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
      globalMutate('/api/v1/discover/watchlist');
      if (mutateParent) {
        mutateParent();
      }
      setToggleWatchlist((prevState) => !prevState);
    }
  };

  const onClickHideItemBtn = async (reason?: string): Promise<void> => {
    setIsUpdating(true);
    const topNode = cardRef.current;

    if (topNode) {
      try {
        if (mediaType === 'collection') {
          await axios.post(`/api/v1/blocklist/collection/${id}`, { reason });
        } else {
          await axios.post('/api/v1/blocklist', {
            tmdbId: id,
            mediaType,
            title,
            user: user?.id,
            reason,
          });
        }
        addToast(
          <span>
            {intl.formatMessage(globalMessages.blocklistSuccess, {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
        setCurrentStatus(MediaStatus.BLOCKLISTED);
        if (mutateParent) {
          mutateParent();
        }
      } catch (e) {
        if (e?.response?.status === 412) {
          addToast(
            <span>
              {intl.formatMessage(globalMessages.blocklistDuplicateError, {
                title,
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

      setIsUpdating(false);
      closeBlocklistModal();
    } else {
      addToast(intl.formatMessage(globalMessages.blocklistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const onClickShowBlocklistBtn = async (): Promise<void> => {
    setIsUpdating(true);
    const topNode = cardRef.current;

    if (topNode) {
      try {
        if (mediaType === 'collection') {
          const res = await axios.delete(`/api/v1/blocklist/collection/${id}`);

          if (res.status === 204) {
            addToast(
              <span>
                {intl.formatMessage(globalMessages.removeFromBlocklistSuccess, {
                  title,
                  strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
                })}
              </span>,
              { appearance: 'success', autoDismiss: true }
            );
            setCurrentStatus(MediaStatus.UNKNOWN);
            if (mutateParent) {
              mutateParent();
            }
          } else {
            addToast(intl.formatMessage(globalMessages.blocklistError), {
              appearance: 'error',
              autoDismiss: true,
            });
          }
        } else {
          const res = await axios.delete(
            `/api/v1/blocklist/${id}?mediaType=${mediaType}`
          );

          if (res.status === 204) {
            addToast(
              <span>
                {intl.formatMessage(globalMessages.removeFromBlocklistSuccess, {
                  title,
                  strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
                })}
              </span>,
              { appearance: 'success', autoDismiss: true }
            );
            setCurrentStatus(MediaStatus.UNKNOWN);
            if (mutateParent) {
              mutateParent();
            }
          } else {
            addToast(intl.formatMessage(globalMessages.blocklistError), {
              appearance: 'error',
              autoDismiss: true,
            });
          }
        }
      } catch {
        addToast(intl.formatMessage(globalMessages.blocklistError), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    } else {
      addToast(intl.formatMessage(globalMessages.blocklistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    }

    setIsUpdating(false);
  };

  const closeModal = useCallback(() => setShowRequestModal(false), []);

  const showRequestButton = hasPermission(
    [
      Permission.REQUEST,
      mediaType === 'movie' || mediaType === 'collection'
        ? Permission.REQUEST_MOVIE
        : Permission.REQUEST_TV,
    ],
    { type: 'or' }
  );

  const showHideButton = hasPermission([Permission.MANAGE_BLOCKLIST], {
    type: 'or',
  });

  const requestable =
    !currentStatus ||
    currentStatus === MediaStatus.UNKNOWN ||
    currentStatus === MediaStatus.DELETED;

  return (
    <CardShell
      detail={detail}
      canExpand={canExpand}
      testId="title-card"
      cardRef={cardRef}
      modals={
        <>
          <RequestModal
            tmdbId={id}
            show={showRequestModal}
            type={
              mediaType === 'movie'
                ? 'movie'
                : mediaType === 'collection'
                  ? 'collection'
                  : 'tv'
            }
            onComplete={requestComplete}
            onUpdating={requestUpdating}
            onCancel={closeModal}
          />
          <BlocklistModal
            tmdbId={id}
            type={
              mediaType === 'movie'
                ? 'movie'
                : mediaType === 'collection'
                  ? 'collection'
                  : 'tv'
            }
            show={showBlocklistModal}
            onCancel={closeBlocklistModal}
            onComplete={onClickHideItemBtn}
            isUpdating={isUpdating}
          />
        </>
      }
      image={
        <CachedImage
          type="tmdb"
          className="absolute inset-0 h-full w-full"
          alt=""
          src={
            image
              ? `https://image.tmdb.org/t/p/w300_and_h450_face${image}`
              : `/images/seerr_poster_not_found_logo_top.png`
          }
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          fill
        />
      }
      badge={{
        label:
          mediaType === 'movie'
            ? intl.formatMessage(globalMessages.movie)
            : mediaType === 'collection'
              ? intl.formatMessage(globalMessages.collection)
              : intl.formatMessage(globalMessages.tvshow),
        className:
          mediaType === 'movie' || mediaType === 'collection'
            ? 'border-blue-500 bg-blue-600/80'
            : 'border-purple-600 bg-purple-600/80',
      }}
      indicators={
        <>
          {onList && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full border border-indigo-500 bg-indigo-600/90 shadow-md sm:h-5 sm:w-5">
              <BookmarkFilledIcon className="h-2.5 w-2.5 text-white sm:h-3 sm:w-3" />
            </span>
          )}
          {notified && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full border border-amber-500 bg-amber-600/90 shadow-md sm:h-5 sm:w-5">
              <BellAlertIcon className="h-2.5 w-2.5 text-white sm:h-3 sm:w-3" />
            </span>
          )}
          {mediaType !== 'person' && mediaType !== 'collection' && (
            <DeletingSoonMarker tmdbId={id} mediaType={mediaType} />
          )}
          {currentStatus && currentStatus !== MediaStatus.UNKNOWN && (
            <StatusBadgeMini
              status={currentStatus}
              inProgress={inProgress}
              shrink
            />
          )}
        </>
      }
      controls={
        <>
          {showDetail && currentStatus !== MediaStatus.BLOCKLISTED && (
            <div className="flex flex-col gap-1">
              {/* Someone with Plex keeps their watchlist on Plex. */}
              {!hasAccountOn(user, 'plex') &&
                (toggleWatchlist ? (
                  <Button
                    buttonType={'ghost'}
                    className="z-40"
                    buttonSize={'sm'}
                    onClick={onClickWatchlistBtn}
                    aria-label={intl.formatMessage(messages.addToWatchList)}
                  >
                    <StarIcon className={'h-3 text-amber-300'} />
                  </Button>
                ) : (
                  <Button
                    className="z-40"
                    buttonSize={'sm'}
                    onClick={onClickDeleteWatchlistBtn}
                    aria-label={intl.formatMessage(
                      messages.removeFromWatchList
                    )}
                  >
                    <MinusCircleIcon className={'h-3'} />
                  </Button>
                ))}
              {showHideButton &&
                currentStatus !== MediaStatus.PROCESSING &&
                currentStatus !== MediaStatus.AVAILABLE &&
                currentStatus !== MediaStatus.PARTIALLY_AVAILABLE &&
                currentStatus !== MediaStatus.PENDING && (
                  <Button
                    buttonType={'ghost'}
                    className="z-40"
                    buttonSize={'sm'}
                    onClick={() => setShowBlocklistModal(true)}
                    aria-label={intl.formatMessage(
                      globalMessages.addToBlocklist
                    )}
                  >
                    <EyeSlashIcon className={'h-3'} />
                  </Button>
                )}
            </div>
          )}
          {showDetail &&
            showHideButton &&
            currentStatus == MediaStatus.BLOCKLISTED && (
              <Tooltip
                content={intl.formatMessage(globalMessages.removefromBlocklist)}
              >
                <Button
                  buttonType={'ghost'}
                  className="z-40"
                  buttonSize={'sm'}
                  onClick={() => onClickShowBlocklistBtn()}
                >
                  <EyeIcon className={'h-3'} />
                </Button>
              </Tooltip>
            )}
        </>
      }
      updating={isUpdating}
      showOverlay={!image || showDetail || showRequestModal}
      href={
        mediaType === 'movie'
          ? `/movie/${id}`
          : mediaType === 'collection'
            ? `/collection/${id}`
            : `/tv/${id}`
      }
      onOpen={preloadPage}
      overline={year}
      title={title}
      titleTestId="title-card-title"
      summary={summary}
      roomForActions={!!actionSlot || (showRequestButton && requestable)}
      actions={
        <>
          {/*
            Rendered in the same slot as the request button and inside the
            card's own transition, so custom actions appear and scale with
            the poster as one element rather than tracking it from outside.
          */}
          {actionSlot}
          {/*
            Keep takes the Request button's place. They never compete:
            Request shows only for titles not in the library, and only
            titles in the library are deleted.
          */}
          {!actionSlot &&
            mediaType !== 'person' &&
            mediaType !== 'collection' && (
              <KeepButton
                tmdbId={id}
                mediaType={mediaType}
                title={title}
                compact
              />
            )}
          {!actionSlot && showRequestButton && requestable && (
            <Button
              buttonType="primary"
              buttonSize="sm"
              onClick={(e) => {
                e.preventDefault();
                setShowRequestModal(true);
              }}
              className="h-7 w-full"
            >
              <ArrowDownTrayIcon />
              <span>{intl.formatMessage(globalMessages.request)}</span>
            </Button>
          )}
          {/*
            Add to a watch list without opening the title. Icon-only and
            lazy: it fetches nothing until opened, so a grid of cards costs
            no extra requests.
          */}
          {showListButton && mediaType !== 'person' && (
            <AddToList
              compact
              mediaType={mediaType === 'tv' ? 'tv' : 'movie'}
              tmdbId={id}
            />
          )}
        </>
      }
    />
  );
};

// A row of cards re-renders each time its data or loading state changes;
// the cards whose own details did not change need not render again with it.
export default withProperties(memo(TitleCard), { Placeholder, ErrorCard });
