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
import { cardRequestable } from '@app/utils/outsideLibraries';
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
  /** Backdrop preloaded when the title's page is opened. */
  backdrop?: string;
  summary?: string;
  year?: string;
  title: string;
  userScore?: number;
  mediaType: MediaType;
  status?: MediaStatus;
  /**
   * A media server has it, but not in the viewer's libraries: nothing to
   * request (lib/libraryVisibility).
   */
  outsideLibraries?: boolean;
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
  outsideLibraries = false,
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

  // Preload the page's header images alongside the navigation.
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

      // The status prop comes from these responses and the effect above syncs
      // it, so without a refresh the next render resets the card to
      // unrequested.
      globalMutate(
        (key: unknown) =>
          typeof key === 'string' &&
          (key.startsWith('/api/v1/discover') ||
            key.startsWith('/api/v1/search') ||
            key.startsWith('/api/v1/media'))
      );
      globalMutate(MARKERS_KEY);
      // Paged rows aren't covered by the refresh above.
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

  const requestable = cardRequestable(currentStatus, outsideLibraries);

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
            ? 'border-blue-500 bg-blue-600/fill'
            : 'border-purple-600 bg-purple-600/fill',
      }}
      indicators={
        <>
          {onList && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full border border-indigo-500 bg-indigo-600/90 shadow-md light:bg-indigo-600 sm:h-5 sm:w-5">
              <BookmarkFilledIcon className="h-2.5 w-2.5 text-white sm:h-3 sm:w-3" />
            </span>
          )}
          {notified && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full border border-amber-500 bg-amber-600/90 shadow-md light:bg-amber-600 sm:h-5 sm:w-5">
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
              {/* Plex users keep their watchlist on Plex. */}
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
          {/* In the request button's slot, so it shares the card's transition. */}
          {actionSlot}
          {/*
            Keep shares Request's slot without conflict: Request is only for
            titles not in the library, and only library titles get deleted.
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
          {/* Fetches nothing until opened, so a grid costs no requests. */}
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

// Memoised so unchanged cards skip re-rendering when their row updates.
export default withProperties(memo(TitleCard), { Placeholder, ErrorCard });
