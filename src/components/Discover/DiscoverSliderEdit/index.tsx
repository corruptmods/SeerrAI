import Button from '@app/components/Common/Button';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import Tag from '@app/components/Common/Tag';
import Tooltip from '@app/components/Common/Tooltip';
import CompanyTag from '@app/components/CompanyTag';
import CreateSlider from '@app/components/Discover/CreateSlider';
import { sliderTitles } from '@app/components/Discover/constants';
import GenreTag from '@app/components/GenreTag';
import KeywordTag from '@app/components/KeywordTag';
import { WatchProviderTags } from '@app/components/Selector';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import {
  ArrowUturnLeftIcon,
  Bars3Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  EyeIcon,
  EyeSlashIcon,
  PencilIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import { DiscoverSliderType } from '@server/constants/discover';
import type DiscoverSlider from '@server/entity/DiscoverSlider';
import axios from 'axios';
import { useRef, useState } from 'react';
import { useDrag, useDrop } from 'react-aria';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.DiscoverSliderEdit', {
  deletesuccess: 'Sucessfully deleted slider.',
  deletefail: 'Failed to delete slider.',
  remove: 'Remove',
  moveUp: 'Move up',
  moveDown: 'Move down',
  enable: 'Shown to everyone',
  showForMe: 'Show on my home page',
  hideForMe: 'Hide for me only',
  hiddenForMe: 'Hidden for you only',
});

const Position = {
  None: 'None',
  Above: 'Above',
  Below: 'Below',
} as const;

type DiscoverSliderEditProps = {
  slider: Partial<DiscoverSlider>;
  onEnable: () => void;
  onDelete: () => void;
  onPositionUpdate: (
    updatedItemId: number,
    position: keyof typeof Position,
    isClickable: boolean
  ) => void;
  children: React.ReactNode;
  disableUpButton: boolean;
  disableDownButton: boolean;
  /** Not an admin: only showing or hiding it for themselves. */
  personalOnly?: boolean;
  /** This person hid it for themselves. */
  hiddenForMe?: boolean;
  onToggleMine?: () => void;
};

const DiscoverSliderEdit = ({
  slider,
  children,
  onEnable,
  onDelete,
  onPositionUpdate,
  disableUpButton,
  disableDownButton,
  personalOnly = false,
  hiddenForMe = false,
  onToggleMine,
}: DiscoverSliderEditProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isEditing, setIsEditing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [hoverPosition, setHoverPosition] = useState<keyof typeof Position>(
    Position.None
  );

  const { dragProps, isDragging } = useDrag({
    getItems() {
      return [{ id: (slider.id ?? -1).toString(), title: slider.title ?? '' }];
    },
  });

  const deleteSlider = async () => {
    try {
      await axios.delete(`/api/v1/settings/discover/${slider.id}`);
      addToast(intl.formatMessage(messages.deletesuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
      onDelete();
    } catch {
      addToast(intl.formatMessage(messages.deletefail), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const { dropProps } = useDrop({
    ref,
    onDropMove: (e) => {
      if (ref.current) {
        const middlePoint = ref.current.offsetHeight / 2;

        if (e.y < middlePoint) {
          setHoverPosition(Position.Above);
        } else {
          setHoverPosition(Position.Below);
        }
      }
    },
    onDropExit: () => {
      setHoverPosition(Position.None);
    },
    onDrop: async (e) => {
      const items = await Promise.all(
        e.items
          .filter((item) => item.kind === 'text' && item.types.has('id'))
          .map(async (item) => {
            if (item.kind === 'text') {
              return item.getText('id');
            }
          })
      );
      if (items?.[0]) {
        const dropped = Number(items[0]);
        onPositionUpdate(dropped, hoverPosition, false);
      }
    },
  });

  const getSliderTitle = (slider: Partial<DiscoverSlider>): string => {
    switch (slider.type) {
      case DiscoverSliderType.RECENTLY_ADDED:
        return intl.formatMessage(sliderTitles.recentlyAdded);
      case DiscoverSliderType.RECENT_REQUESTS:
        return intl.formatMessage(sliderTitles.recentrequests);
      case DiscoverSliderType.PLEX_WATCHLIST:
        return intl.formatMessage(sliderTitles.plexwatchlist);
      case DiscoverSliderType.SUGGESTED:
        return intl.formatMessage(sliderTitles.suggested);
      case DiscoverSliderType.DELETING_SOON:
        return intl.formatMessage(sliderTitles.deletingSoon);
      case DiscoverSliderType.TRENDING:
        return intl.formatMessage(sliderTitles.trending);
      case DiscoverSliderType.POPULAR_MOVIES:
        return intl.formatMessage(sliderTitles.popularmovies);
      case DiscoverSliderType.MOVIE_GENRES:
        return intl.formatMessage(sliderTitles.moviegenres);
      case DiscoverSliderType.UPCOMING_MOVIES:
        return intl.formatMessage(sliderTitles.upcoming);
      case DiscoverSliderType.STUDIOS:
        return intl.formatMessage(sliderTitles.studios);
      case DiscoverSliderType.POPULAR_TV:
        return intl.formatMessage(sliderTitles.populartv);
      case DiscoverSliderType.TV_GENRES:
        return intl.formatMessage(sliderTitles.tvgenres);
      case DiscoverSliderType.UPCOMING_TV:
        return intl.formatMessage(sliderTitles.upcomingtv);
      case DiscoverSliderType.NETWORKS:
        return intl.formatMessage(sliderTitles.networks);
      case DiscoverSliderType.ANIME:
        return intl.formatMessage(sliderTitles.anime);
      case DiscoverSliderType.MUSIC_RECENTLY_ADDED:
        return intl.formatMessage(sliderTitles.musicRecentlyAdded);
      case DiscoverSliderType.MUSIC_NEW_RELEASES:
        return intl.formatMessage(sliderTitles.musicNewReleases);
      case DiscoverSliderType.MUSIC_POPULAR_ALBUMS:
        return intl.formatMessage(sliderTitles.musicPopularAlbums);
      case DiscoverSliderType.MUSIC_POPULAR_ARTISTS:
        return intl.formatMessage(sliderTitles.musicPopularArtists);
      case DiscoverSliderType.TMDB_MOVIE_KEYWORD:
        return intl.formatMessage(sliderTitles.tmdbmoviekeyword);
      case DiscoverSliderType.TMDB_TV_KEYWORD:
        return intl.formatMessage(sliderTitles.tmdbtvkeyword);
      case DiscoverSliderType.TMDB_MOVIE_GENRE:
        return intl.formatMessage(sliderTitles.tmdbmoviegenre);
      case DiscoverSliderType.TMDB_TV_GENRE:
        return intl.formatMessage(sliderTitles.tmdbtvgenre);
      case DiscoverSliderType.TMDB_STUDIO:
        return intl.formatMessage(sliderTitles.tmdbstudio);
      case DiscoverSliderType.TMDB_NETWORK:
        return intl.formatMessage(sliderTitles.tmdbnetwork);
      case DiscoverSliderType.TMDB_SEARCH:
        return intl.formatMessage(sliderTitles.tmdbsearch);
      case DiscoverSliderType.TMDB_MOVIE_STREAMING_SERVICES:
        return intl.formatMessage(sliderTitles.tmdbmoviestreamingservices);
      case DiscoverSliderType.TMDB_TV_STREAMING_SERVICES:
        return intl.formatMessage(sliderTitles.tmdbtvstreamingservices);
      default:
        return 'Unknown Slider';
    }
  };

  return (
    <div
      key={`discover-slider-${slider.id}-editing`}
      data-testid="discover-slider-edit-mode"
      className={`relative mb-4 rounded-lg bg-surface shadow-md ${
        isDragging ? 'opacity-0' : 'opacity-100'
      }`}
      {...(personalOnly ? {} : dragProps)}
      {...(personalOnly ? {} : dropProps)}
      ref={ref}
    >
      {hoverPosition === Position.Above && (
        <div
          className={`absolute -top-3 left-0 w-full border-t-4 border-indigo-500`}
        />
      )}
      {hoverPosition === Position.Below && (
        <div
          className={`absolute -bottom-2 left-0 w-full border-t-4 border-indigo-500`}
        />
      )}
      <div className="flex w-full flex-col rounded-t-lg border-l border-r border-t border-gray-800 bg-page p-4 text-muted md:flex-row md:items-center md:space-x-2">
        <div
          className={`${slider.data ? 'mb-4' : 'mb-0'} flex space-x-2 md:mb-0`}
        >
          {!personalOnly && <Bars3Icon className="h-6 w-6" />}
          <div className="w-7/12 truncate md:w-full">
            {getSliderTitle(slider)}
          </div>
        </div>
        <div
          className={`pointer-events-none ${
            slider.data ? 'mb-4' : ''
          } flex-1 md:mb-0`}
        >
          {(slider.type === DiscoverSliderType.TMDB_MOVIE_KEYWORD ||
            slider.type === DiscoverSliderType.TMDB_TV_KEYWORD) && (
            <div className="flex space-x-2">
              {slider.data?.split(',').map((keywordId) => (
                <KeywordTag
                  key={`slider-keywords-${slider.id}-${keywordId}`}
                  keywordId={Number(keywordId)}
                />
              ))}
            </div>
          )}
          {(slider.type === DiscoverSliderType.TMDB_NETWORK ||
            slider.type === DiscoverSliderType.TMDB_STUDIO) && (
            <CompanyTag
              type={
                slider.type === DiscoverSliderType.TMDB_STUDIO
                  ? 'studio'
                  : 'network'
              }
              companyId={Number(slider.data)}
            />
          )}
          {(slider.type === DiscoverSliderType.TMDB_TV_GENRE ||
            slider.type === DiscoverSliderType.TMDB_MOVIE_GENRE) && (
            <GenreTag
              type={
                slider.type === DiscoverSliderType.TMDB_MOVIE_GENRE
                  ? 'movie'
                  : 'tv'
              }
              genreId={Number(slider.data)}
            />
          )}
          {slider.type === DiscoverSliderType.TMDB_SEARCH && (
            <Tag iconSvg={<MagnifyingGlassIcon />}>{slider.data}</Tag>
          )}
          {(slider.type === DiscoverSliderType.TMDB_MOVIE_STREAMING_SERVICES ||
            slider.type === DiscoverSliderType.TMDB_TV_STREAMING_SERVICES) && (
            <WatchProviderTags
              type={
                slider.type === DiscoverSliderType.TMDB_MOVIE_STREAMING_SERVICES
                  ? 'movie'
                  : 'tv'
              }
              data={slider.data}
            />
          )}
        </div>
        {personalOnly ? (
          <div className="absolute right-4 top-4 md:relative md:right-0 md:top-0">
            <Tooltip content={intl.formatMessage(messages.showForMe)}>
              <div>
                <SlideCheckbox
                  label={intl.formatMessage(messages.showForMe)}
                  onClick={() => onToggleMine?.()}
                  checked={!hiddenForMe}
                />
              </div>
            </Tooltip>
          </div>
        ) : (
          <div className="flex items-center space-x-2">
            <Tooltip
              content={intl.formatMessage(
                hiddenForMe ? messages.hiddenForMe : messages.hideForMe
              )}
            >
              <button
                type="button"
                className={`absolute right-36 top-4 md:relative md:right-0 md:top-0 ${
                  hiddenForMe
                    ? 'text-accent-soft light:text-accent-text'
                    : 'hover:text-strong'
                }`}
                aria-label={intl.formatMessage(
                  hiddenForMe ? messages.hiddenForMe : messages.hideForMe
                )}
                aria-pressed={hiddenForMe}
                onClick={() => onToggleMine?.()}
              >
                {hiddenForMe ? (
                  <EyeSlashIcon className="h-6 w-6" />
                ) : (
                  <EyeIcon className="h-6 w-6" />
                )}
              </button>
            </Tooltip>
            {!slider.isBuiltIn && (
              <>
                {!isEditing ? (
                  <Button
                    buttonType="warning"
                    buttonSize="sm"
                    onClick={() => {
                      setIsEditing(true);
                    }}
                  >
                    <PencilIcon />
                    <span>{intl.formatMessage(globalMessages.edit)}</span>
                  </Button>
                ) : (
                  <Button
                    buttonType="default"
                    buttonSize="sm"
                    onClick={() => {
                      setIsEditing(false);
                    }}
                  >
                    <ArrowUturnLeftIcon />
                    <span>{intl.formatMessage(globalMessages.cancel)}</span>
                  </Button>
                )}
                <Button
                  data-testid="discover-slider-remove-button"
                  buttonType="danger"
                  buttonSize="sm"
                  onClick={() => {
                    deleteSlider();
                  }}
                >
                  <XMarkIcon />
                  <span>{intl.formatMessage(messages.remove)}</span>
                </Button>
              </>
            )}
            <div className="absolute right-14 top-4 flex px-2 md:relative md:right-0 md:top-0">
              <button
                className={'hover:text-strong disabled:text-gray-800'}
                onClick={() =>
                  onPositionUpdate(Number(slider.id), Position.Above, true)
                }
                disabled={disableUpButton}
                aria-label={intl.formatMessage(messages.moveUp)}
              >
                <ChevronUpIcon className="h-7 w-7 md:h-6 md:w-6" />
              </button>
              <button
                className={'hover:text-strong disabled:text-gray-800'}
                onClick={() =>
                  onPositionUpdate(Number(slider.id), Position.Below, true)
                }
                disabled={disableDownButton}
                aria-label={intl.formatMessage(messages.moveDown)}
              >
                <ChevronDownIcon className="h-7 w-7 md:h-6 md:w-6" />
              </button>
            </div>
            <div className="absolute right-4 top-4 flex-1 text-right md:relative md:right-0 md:top-0">
              <Tooltip content={intl.formatMessage(messages.enable)}>
                <div>
                  <SlideCheckbox
                    label={intl.formatMessage(messages.enable)}
                    onClick={() => {
                      onEnable();
                    }}
                    checked={slider.enabled}
                  />
                </div>
              </Tooltip>
            </div>
          </div>
        )}
      </div>
      {isEditing ? (
        <div className="p-4">
          <CreateSlider
            onCreate={() => {
              onDelete();
              setIsEditing(false);
            }}
            slider={slider}
          />
        </div>
      ) : (
        <div
          className={`-mt-6 p-4 ${
            !slider.enabled || hiddenForMe ? 'opacity-50' : ''
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
};

export default DiscoverSliderEdit;
