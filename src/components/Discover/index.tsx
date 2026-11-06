import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import { SliderRowsSkeleton } from '@app/components/Common/PageSkeleton';
import PageTitle from '@app/components/Common/PageTitle';
import RowBoundary from '@app/components/Common/RowBoundary';
import Tooltip from '@app/components/Common/Tooltip';
import DeletingSoonSlider from '@app/components/Discover/DeletingSoonSlider';
import MovieGenreSlider from '@app/components/Discover/MovieGenreSlider';
import NetworkSlider from '@app/components/Discover/NetworkSlider';
import PlexWatchlistSlider from '@app/components/Discover/PlexWatchlistSlider';
import RecentRequestsSlider from '@app/components/Discover/RecentRequestsSlider';
import RecentlyAddedSlider from '@app/components/Discover/RecentlyAddedSlider';
import StudioSlider from '@app/components/Discover/StudioSlider';
import TvGenreSlider from '@app/components/Discover/TvGenreSlider';
import { animeQuery } from '@app/components/Discover/animeChoices';
import { sliderTitles } from '@app/components/Discover/constants';
import MediaSlider from '@app/components/MediaSlider';
import MusicSlider from '@app/components/Music/MusicSlider';
import {
  musicRowFor,
  musicRowLink,
  musicRowUrl,
} from '@app/components/Music/musicRows';
import { loadNavEditor, useNavLayout } from '@app/context/NavLayoutContext';
import { encodeURIExtraParams } from '@app/hooks/useDiscover';
import { useFeatureCheck } from '@app/hooks/useFeature';
import useLazyModule, { loadModule } from '@app/hooks/useLazyModule';
import usePageReturn from '@app/hooks/usePageReturn';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  ArrowDownOnSquareIcon,
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  PencilIcon,
  PlusIcon,
} from '@heroicons/react/24/solid';
import { DiscoverSliderType } from '@server/constants/discover';
import { MAX_DISCOVER_NETWORKS } from '@server/constants/discoverNetworks';
import { ApiErrorCode } from '@server/constants/error';
import {
  editableNavLayout,
  isDefaultNavOrder,
  sameNavLayout,
} from '@server/constants/navigation';
import {
  readStreamingRow,
  streamingServiceQuery,
} from '@server/constants/streamingServices';
import type DiscoverSlider from '@server/entity/DiscoverSlider';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

// Heavy editor modules (drag-and-drop, selects) load only when editing
// starts. The sidebar editor loads with them, so a failed load is reported
// once, here.
const loadEditor = () =>
  Promise.all([
    import('@app/components/Discover/CreateSlider'),
    import('@app/components/Discover/DiscoverSliderEdit'),
    loadModule(loadNavEditor),
  ]).then(([create, edit]) => ({
    CreateSlider: create.default,
    DiscoverSliderEdit: edit.default,
  }));

const messages = defineMessages('components.Discover', {
  discover: 'Discover',
  couldnotedit:
    'The editor could not be opened. Check your connection and try again.',
  emptywatchlist:
    'Titles on your <PlexWatchlistSupportLink>Plex Watchlist</PlexWatchlistSupportLink> show here.',
  resettodefault: 'Reset to Default',
  resetwarning: 'Resets all sliders to default and deletes custom ones.',
  updatesuccess: 'Updated discover customization settings.',
  updatefailed:
    'Something went wrong updating the discover customization settings.',
  resetsuccess: 'Sucessfully reset discover customization settings.',
  resetfailed:
    'Something went wrong resetting the discover customization settings.',
  customizediscover: 'Customize Discover',
  customizemine: 'Choose what your home page shows',
  stopediting: 'Stop Editing',
  showall: 'Show All Rows',
  personalsaved: 'Your home page is saved.',
  personalfailed: 'Your home page could not be saved.',
  toomanynetworks: 'A network list can contain at most {maxNetworks} networks.',
  invalidnetworklist: 'The list of networks is not valid.',
  createnewslider: 'Create New Slider',
});

/**
 * Merges the server's list into the edited one, keeping unsaved order,
 * toggles and Networks list.
 */
const mergeRefreshedSliders = (
  current: Partial<DiscoverSlider>[],
  refreshed: DiscoverSlider[]
): Partial<DiscoverSlider>[] => {
  const refreshedById = new Map(refreshed.map((s) => [s.id, s]));
  const currentIds = new Set(current.map((s) => s.id));
  // New sliders are created at order -1, so they go first.
  const added = refreshed.filter((s) => !currentIds.has(s.id));
  const kept = current.flatMap((slider) => {
    const fresh = refreshedById.get(slider.id as number);
    if (!fresh) return [];
    // Built-in sliders only change here, so the local copy is newer.
    return [
      fresh.isBuiltIn
        ? slider
        : { ...slider, title: fresh.title, type: fresh.type, data: fresh.data },
    ];
  });
  return [...added, ...kept];
};

const Discover = () => {
  const intl = useIntl();
  const featureIsOn = useFeatureCheck();
  const { user, hasPermission, revalidate: revalidateUser } = useUser();
  const isAdmin = hasPermission(Permission.ADMIN);
  // The user's own hidden rows: saved and draft.
  const savedHidden = user?.settings?.hiddenSliders ?? [];
  const [myHidden, setMyHidden] = useState<number[]>(savedHidden);
  // The user's own Networks list (null: the default): saved and draft.
  const savedNetworks = user?.settings?.discoverNetworks ?? null;
  const [myNetworks, setMyNetworks] = useState<string | null>(savedNetworks);
  const { addToast } = useToasts();
  const {
    data: discoverData,
    error: discoverError,
    mutate,
  } = useSWR<DiscoverSlider[]>('/api/v1/settings/discover');
  // Rows from the cache on the first render, so a step back has the page's
  // height before the browser puts its scroll back.
  const [sliders, setSliders] = useState<Partial<DiscoverSlider>[]>(
    () => discoverData ?? []
  );
  const [isEditing, setIsEditing] = useState(false);
  // Menu layout is edited in the menus themselves and saved with the page.
  const nav = useNavLayout();
  const { setDraft: setNavDraft } = nav;
  const editor = useLazyModule(loadEditor, isEditing, () => {
    addToast(intl.formatMessage(messages.couldnotedit), {
      appearance: 'error',
      autoDismiss: true,
    });
    setIsEditing(false);
  });
  const CreateSlider = editor?.CreateSlider;
  const DiscoverSliderEdit = editor?.DiscoverSliderEdit;

  // Local copy so edits stay unsaved until the user saves.
  useEffect(() => {
    if (discoverData && !isEditing) {
      setSliders(discoverData);
    }
  }, [discoverData, isEditing]);
  const savedHiddenKey = savedHidden.join(',');
  useEffect(() => {
    if (!isEditing) {
      setMyHidden(savedHiddenKey ? savedHiddenKey.split(',').map(Number) : []);
    }
  }, [savedHiddenKey, isEditing]);
  useEffect(() => {
    if (!isEditing) {
      setMyNetworks(savedNetworks);
    }
  }, [savedNetworks, isEditing]);
  // Menu editors show while customizing, until it ends or the page unmounts.
  const savedNav = nav.saved;
  useEffect(() => {
    setNavDraft(isEditing ? editableNavLayout(savedNav) : undefined);
    // Only on start/end: anything saved meanwhile is the draft itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, setNavDraft]);
  useEffect(() => () => setNavDraft(undefined), [setNavDraft]);
  // Coming back after a reload or resume: the scroll, once the rows are laid
  // out (each row keeps its sideways scroll itself).
  usePageReturn('home', { isReady: () => !!discoverData || !!discoverError });

  const layoutChanged = () => isAdmin && !Object.is(discoverData, sliders);
  const hiddenChanged = () =>
    [...myHidden].sort().join(',') !== [...savedHidden].sort().join(',');
  const networksChanged = () => myNetworks !== savedNetworks;
  const navChanged = () => !!nav.draft && !sameNavLayout(nav.draft, nav.saved);
  const mineChanged = () =>
    hiddenChanged() || networksChanged() || navChanged();
  const hasChanged = () => layoutChanged() || mineChanged();
  const hiddenForMe = (id?: number) =>
    id !== undefined && myHidden.includes(id);

  const refreshSliders = async () => {
    const refreshed = await mutate();
    if (refreshed) {
      setSliders((current) => mergeRefreshedSliders(current, refreshed));
    }
  };

  const updateSliders = async () => {
    try {
      if (layoutChanged()) {
        await axios.post('/api/v1/settings/discover', sliders);
      }
      if ((hiddenChanged() || networksChanged()) && user) {
        await axios.post(`/api/v1/user/${user.id}/settings/discover`, {
          hidden: myHidden,
          networks: myNetworks,
        });
      }
      if (navChanged() && nav.draft && user) {
        await axios.post(`/api/v1/user/${user.id}/settings/sidebar`, {
          // Store the default order as [] so later-added items take their
          // default place.
          order: isDefaultNavOrder(nav.draft.order) ? [] : nav.draft.order,
          hidden: nav.draft.hidden,
        });
      }
      if (mineChanged()) {
        await revalidateUser();
      }

      addToast(
        intl.formatMessage(
          isAdmin ? messages.updatesuccess : messages.personalsaved
        ),
        {
          appearance: 'success',
          autoDismiss: true,
        }
      );
      setIsEditing(false);
      mutate();
    } catch (e) {
      // A rejected Networks list returns 400 with a reason code.
      const code =
        axios.isAxiosError(e) && e.response?.status === 400
          ? e.response.data?.message
          : undefined;
      addToast(
        code === ApiErrorCode.TooManyNetworks
          ? intl.formatMessage(messages.toomanynetworks, {
              maxNetworks: MAX_DISCOVER_NETWORKS,
            })
          : code === ApiErrorCode.InvalidNetworkList
            ? intl.formatMessage(messages.invalidnetworklist)
            : intl.formatMessage(
                isAdmin ? messages.updatefailed : messages.personalfailed
              ),
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    }
  };

  const resetSliders = async () => {
    try {
      await axios.post('/api/v1/settings/discover/reset');

      addToast(intl.formatMessage(messages.resetsuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
      setIsEditing(false);
      mutate();
    } catch {
      addToast(intl.formatMessage(messages.resetfailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const now = new Date();
  const offset = now.getTimezoneOffset();
  const upcomingDate = new Date(now.getTime() - offset * 60 * 1000)
    .toISOString()
    .split('T')[0];
  const animeThisSeason = animeQuery('this');

  if (!discoverData && !discoverError) {
    return <SliderRowsSkeleton />;
  }

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.discover)} />
      {user && (
        <>
          {isAdmin && isEditing && CreateSlider && (
            <div className="my-6 rounded-lg bg-surface">
              <div className="flex items-center space-x-2 rounded-t-lg border-l border-r border-t border-gray-800 bg-page p-4 text-lg font-semibold text-muted">
                <PlusIcon className="w-6" />
                <span data-testid="create-slider-header">
                  {intl.formatMessage(messages.createnewslider)}
                </span>
              </div>
              <div className="p-4">
                <CreateSlider onCreate={refreshSliders} />
              </div>
            </div>
          )}
          <Transition
            as="div"
            show={!isEditing}
            enter="transition-opacity duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="transition-opacity duration-300"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
            className="absolute-bottom-shift fixed right-6 z-50 flex items-center sm:bottom-8"
          >
            <button
              onClick={() => setIsEditing(true)}
              data-testid="discover-start-editing"
              aria-label={intl.formatMessage(
                isAdmin ? messages.customizediscover : messages.customizemine
              )}
              title={intl.formatMessage(
                isAdmin ? messages.customizediscover : messages.customizemine
              )}
              className="h-12 w-12 rounded-full border-2 border-strong bg-gray-700/90 p-3 text-muted shadow transition-all hover:bg-gray-700"
            >
              <PencilIcon className="h-full w-full" />
            </button>
          </Transition>
          <Transition
            as="div"
            show={isEditing}
            enter="transition duration-300"
            enterFrom="opacity-0 translate-y-6"
            enterTo="opacity-100 translate-y-0"
            leave="transition duration-300"
            leaveFrom="opacity-100 translate-y-0"
            leaveTo="opacity-0 translate-y-6"
            className="safe-shift-edit-menu fixed left-0 right-0 z-50 flex flex-col items-center justify-end space-x-0 space-y-2 border-t border-subtle bg-surface/80 p-4 backdrop-blur sm:bottom-0 sm:flex-row sm:space-x-3 sm:space-y-0"
          >
            <Button
              buttonType="default"
              onClick={() => setIsEditing(false)}
              className="w-full sm:w-auto"
            >
              <ArrowUturnLeftIcon />
              <span>{intl.formatMessage(messages.stopediting)}</span>
            </Button>
            {isAdmin ? (
              <Tooltip content={intl.formatMessage(messages.resetwarning)}>
                <ConfirmButton
                  onClick={() => resetSliders()}
                  confirmText={intl.formatMessage(globalMessages.areyousure)}
                  className="w-full sm:w-auto"
                >
                  <ArrowPathIcon />
                  <span>{intl.formatMessage(messages.resettodefault)}</span>
                </ConfirmButton>
              </Tooltip>
            ) : (
              <Button
                buttonType="default"
                onClick={() => setMyHidden([])}
                disabled={!myHidden.length}
                className="w-full sm:w-auto"
              >
                <ArrowPathIcon />
                <span>{intl.formatMessage(messages.showall)}</span>
              </Button>
            )}
            <Button
              buttonType="primary"
              type="submit"
              disabled={!hasChanged()}
              onClick={() => updateSliders()}
              data-testid="discover-customize-submit"
              className="w-full sm:w-auto"
            >
              <ArrowDownOnSquareIcon />
              <span>{intl.formatMessage(globalMessages.save)}</span>
            </Button>
          </Transition>
        </>
      )}
      {(isEditing
        ? // Non-admins only choose among rows an admin enabled.
          isAdmin
          ? sliders
          : sliders.filter((slider) => slider.enabled)
        : discoverData
      )?.map((slider, index) => {
        let sliderComponent: React.ReactNode;

        // Music rows are absent, even when editing, without the music feature.
        const musicRow = musicRowFor(slider.type);
        if (musicRow && !featureIsOn('music')) {
          return null;
        }
        if (musicRow) {
          sliderComponent = (
            <MusicSlider
              sliderKey={`music-${musicRow.show}`}
              title={intl.formatMessage(musicRow.title)}
              url={musicRowUrl(musicRow)}
              linkUrl={musicRowLink(musicRow)}
            />
          );
        }

        switch (slider.type) {
          case DiscoverSliderType.DELETING_SOON:
            // Renders only while Maintainerr has items due and it is on.
            sliderComponent = <DeletingSoonSlider />;
            break;
          case DiscoverSliderType.RECENTLY_ADDED:
            sliderComponent = <RecentlyAddedSlider />;
            break;
          case DiscoverSliderType.RECENT_REQUESTS:
            sliderComponent = <RecentRequestsSlider />;
            break;
          case DiscoverSliderType.MUSIC_RECENT_REQUESTS:
            if (!featureIsOn('music')) {
              return null;
            }
            sliderComponent = <RecentRequestsSlider music />;
            break;
          case DiscoverSliderType.PLEX_WATCHLIST:
            sliderComponent = <PlexWatchlistSlider />;
            break;
          case DiscoverSliderType.SUGGESTED:
            // Per-user; hidden when off or empty, but kept while editing so
            // it can be moved.
            if (!isEditing && !featureIsOn('suggestedForYou')) {
              break;
            }
            sliderComponent = (
              <MediaSlider
                sliderKey="suggested"
                title={intl.formatMessage(sliderTitles.suggested)}
                url="/api/v1/discover/suggested"
                linkUrl="/discover/suggested"
                hideWhenEmpty
              />
            );
            break;
          case DiscoverSliderType.TRENDING:
            sliderComponent = (
              <MediaSlider
                sliderKey="trending"
                title={intl.formatMessage(sliderTitles.trending)}
                url="/api/v1/discover/trending"
                linkUrl="/discover/trending"
              />
            );
            break;
          case DiscoverSliderType.POPULAR_MOVIES:
            sliderComponent = (
              <MediaSlider
                sliderKey="popular-movies"
                title={intl.formatMessage(sliderTitles.popularmovies)}
                url="/api/v1/discover/movies"
                linkUrl="/discover/movies"
              />
            );
            break;
          case DiscoverSliderType.MOVIE_GENRES:
            sliderComponent = <MovieGenreSlider />;
            break;
          case DiscoverSliderType.UPCOMING_MOVIES:
            sliderComponent = (
              <MediaSlider
                sliderKey="upcoming"
                title={intl.formatMessage(sliderTitles.upcoming)}
                linkUrl={`/discover/movies?primaryReleaseDateGte=${upcomingDate}`}
                url="/api/v1/discover/movies"
                extraParams={`primaryReleaseDateGte=${upcomingDate}`}
              />
            );
            break;
          case DiscoverSliderType.STUDIOS:
            sliderComponent = <StudioSlider />;
            break;
          case DiscoverSliderType.POPULAR_TV:
            sliderComponent = (
              <MediaSlider
                sliderKey="popular-tv"
                title={intl.formatMessage(sliderTitles.populartv)}
                url="/api/v1/discover/tv"
                linkUrl="/discover/tv"
              />
            );
            break;
          case DiscoverSliderType.TV_GENRES:
            sliderComponent = <TvGenreSlider />;
            break;
          case DiscoverSliderType.UPCOMING_TV:
            sliderComponent = (
              <MediaSlider
                sliderKey="upcoming-tv"
                title={intl.formatMessage(sliderTitles.upcomingtv)}
                linkUrl={`/discover/tv?firstAirDateGte=${upcomingDate}`}
                url="/api/v1/discover/tv"
                extraParams={`firstAirDateGte=${upcomingDate}`}
              />
            );
            break;
          case DiscoverSliderType.ANIME:
            sliderComponent = (
              <MediaSlider
                sliderKey="anime"
                title={intl.formatMessage(sliderTitles.anime)}
                url="/api/v1/discover/anime"
                extraParams={`show=${animeThisSeason.show}&season=${animeThisSeason.season}`}
                linkUrl="/discover/anime"
              />
            );
            break;
          case DiscoverSliderType.NETWORKS:
            sliderComponent = (
              <NetworkSlider
                // The user's own list, or the default.
                data={isEditing ? myNetworks : savedNetworks}
                isEditing={isEditing}
                onChange={setMyNetworks}
              />
            );
            break;
          case DiscoverSliderType.TMDB_MOVIE_KEYWORD:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url="/api/v1/discover/movies"
                extraParams={
                  slider.data
                    ? `keywords=${encodeURIExtraParams(slider.data)}`
                    : ''
                }
                linkUrl={`/discover/movies?keywords=${slider.data}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_TV_KEYWORD:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url="/api/v1/discover/tv"
                extraParams={
                  slider.data
                    ? `keywords=${encodeURIExtraParams(slider.data)}`
                    : ''
                }
                linkUrl={`/discover/tv?keywords=${slider.data}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_MOVIE_GENRE:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url={`/api/v1/discover/movies`}
                extraParams={`genre=${slider.data}`}
                linkUrl={`/discover/movies?genre=${slider.data}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_TV_GENRE:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url={`/api/v1/discover/tv`}
                extraParams={`genre=${slider.data}`}
                linkUrl={`/discover/tv?genre=${slider.data}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_STUDIO:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url={`/api/v1/discover/movies/studio/${slider.data}`}
                linkUrl={`/discover/movies/studio/${slider.data}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_NETWORK:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url={`/api/v1/discover/tv/network/${slider.data}`}
                linkUrl={`/discover/tv/network/${slider.data}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_SEARCH:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url="/api/v1/search"
                extraParams={`query=${slider.data}`}
                linkUrl={`/search?query=${slider.data}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_MOVIE_STREAMING_SERVICES:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url="/api/v1/discover/movies"
                extraParams={streamingServiceQuery(
                  readStreamingRow(slider.data)
                )}
                linkUrl={`/discover/movies?${streamingServiceQuery(
                  readStreamingRow(slider.data)
                )}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_TV_STREAMING_SERVICES:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url="/api/v1/discover/tv"
                extraParams={streamingServiceQuery(
                  readStreamingRow(slider.data)
                )}
                linkUrl={`/discover/tv?${streamingServiceQuery(
                  readStreamingRow(slider.data)
                )}`}
              />
            );
            break;
        }

        if (isEditing) {
          if (!DiscoverSliderEdit) {
            return null;
          }
          return (
            <DiscoverSliderEdit
              key={`discover-slider-${slider.id}-edit`}
              slider={slider}
              personalOnly={!isAdmin}
              hiddenForMe={hiddenForMe(slider.id)}
              onToggleMine={() => {
                if (slider.id === undefined) return;
                const id = slider.id;
                setMyHidden((current) =>
                  current.includes(id)
                    ? current.filter((x) => x !== id)
                    : [...current, id]
                );
              }}
              onDelete={refreshSliders}
              onEnable={() => {
                // Copy: the objects are shared with SWR's cache.
                setSliders(
                  sliders.map((s, i) =>
                    i === index ? { ...s, enabled: !s.enabled } : s
                  )
                );
              }}
              onPositionUpdate={(updatedItemId, position, hasClickedArrows) => {
                const originalPosition = sliders.findIndex(
                  (item) => item.id === updatedItemId
                );
                const originalItem = sliders[originalPosition];

                const tempSliders = sliders.slice();

                tempSliders.splice(originalPosition, 1);
                if (hasClickedArrows) {
                  tempSliders.splice(
                    position === 'Above' ? index - 1 : index + 1,
                    0,
                    originalItem
                  );
                } else {
                  tempSliders.splice(
                    position === 'Above' && index > originalPosition
                      ? Math.max(index - 1, 0)
                      : index,
                    0,
                    originalItem
                  );
                }

                setSliders(tempSliders);
              }}
              disableUpButton={index === 0}
              disableDownButton={index === sliders.length - 1}
            >
              {sliderComponent}
            </DiscoverSliderEdit>
          );
        }

        if (!slider.enabled || hiddenForMe(slider.id)) {
          return null;
        }

        return (
          <div key={`discover-slider-${slider.id}`}>
            <RowBoundary name={`${slider.type}-${slider.id}`}>
              {sliderComponent}
            </RowBoundary>
          </div>
        );
      })}
    </>
  );
};

export default Discover;
