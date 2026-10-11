import Button from '@app/components/Common/Button';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import PersonCard from '@app/components/PersonCard';
import TitleCard, { EagerPosters } from '@app/components/TitleCard';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import useBulkRequest, { bulkKey } from '@app/hooks/useBulkRequest';
import useSearchText from '@app/hooks/useSearchText';
import { Permission, useUser } from '@app/hooks/useUser';
import useVerticalScroll from '@app/hooks/useVerticalScroll';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { MediaStatus } from '@server/constants/media';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import type {
  CollectionResult,
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import {
  matchesSearch,
  normalizeSearchText,
  searchWords,
} from '@server/utils/searchText';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.ListView', {
  filter: 'Filter by title, cast, character, director, studio',
  filterHint: 'Title, name or studio',
  clearFilter: 'Clear filter',
  matches:
    '{matches, plural, one {# match} other {# matches}} in {loaded} titles',
  lookingThrough: 'Looking through {loaded} titles…',
  lookedThrough: 'Looked through the first {loaded} titles.',
  searchFurther: 'Keep looking',
  nomatch: 'Nothing here matches “{query}”.',
});

type ListItem = TvResult | MovieResult | PersonResult | CollectionResult;

type ListViewProps = {
  items?: ListItem[];
  plexItems?: WatchlistItem[];
  isEmpty?: boolean;
  isLoading?: boolean;
  isReachingEnd?: boolean;
  onScrollBottom: () => void;
  mutateParent?: () => void;
};

/** How many titles a filter looks through before asking to go further. */
const SEARCH_STEP = 400;
/** Matches worth showing before a filter stops loading more on its own. */
const ENOUGH_MATCHES = 24;
const keyOf = bulkKey;

/** Names a title is known by in the list itself, before any details. */
const namesOf = (item: ListItem): string => {
  switch (item.mediaType) {
    case 'movie':
      return `${item.title} ${item.originalTitle ?? ''}`;
    case 'tv':
      return `${item.name} ${item.originalName ?? ''}`;
    case 'person':
      return item.name;
    case 'collection':
      return item.title;
  }
};

const storageKey = (path: string) => `list-filter:${path}`;
const readStored = (path: string): string => {
  try {
    return sessionStorage.getItem(storageKey(path)) ?? '';
  } catch {
    return '';
  }
};

/**
 * A page of posters: every Discover page, search results, a watchlist,
 * recommendations. Each gets a filter over what it shows — by title, cast,
 * the characters they play, who made it, genre and keyword — and a way to
 * pick several titles and request them together.
 */
const ListView = ({
  items,
  isEmpty,
  isLoading,
  onScrollBottom,
  isReachingEnd,
  plexItems,
  mutateParent,
}: ListViewProps) => {
  const intl = useIntl();
  const router = useRouter();
  const { hasPermission } = useUser();

  const blocklistVisibility = hasPermission(
    [Permission.MANAGE_BLOCKLIST, Permission.VIEW_BLOCKLIST],
    { type: 'or' }
  );
  // The filter, kept for this page for the rest of the visit, so it is still
  // there after opening a title and coming back.
  // Per page, not per address: changing a page's own filters or sort keeps it.
  const pagePath = router.asPath.split('?')[0];
  const [filter, setFilter] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const stored = readStored(pagePath);
    setFilter(stored);
    setDebounced(stored);
  }, [pagePath]);
  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(filter), 250);
    try {
      if (filter.trim()) {
        sessionStorage.setItem(storageKey(pagePath), filter);
      } else {
        sessionStorage.removeItem(storageKey(pagePath));
      }
    } catch {
      // Not kept past this page, which is all that is lost.
    }
    return () => clearTimeout(timeout);
  }, [filter, pagePath]);

  const words = useMemo(() => searchWords(debounced), [debounced]);
  const filtering = words.length > 0;

  const visibleItems = useMemo(
    () =>
      (items ?? []).filter(
        (title) =>
          blocklistVisibility ||
          (title as TvResult | MovieResult).mediaInfo?.status !==
            MediaStatus.BLOCKLISTED
      ),
    [items, blocklistVisibility]
  );

  const searchableKeys = useMemo(
    () => [
      ...visibleItems
        .filter((i) => i.mediaType === 'movie' || i.mediaType === 'tv')
        .map((i) => keyOf(i.mediaType, i.id)),
      ...(plexItems ?? []).map((i) => keyOf(i.mediaType, i.tmdbId)),
    ],
    [visibleItems, plexItems]
  );
  const { text, pending } = useSearchText(searchableKeys, filtering);

  const matches = (key: string, names: string) =>
    matchesSearch(
      `${normalizeSearchText(names)} ${text.get(key) ?? ''}`,
      words
    );

  const shownItems = filtering
    ? visibleItems.filter((i) => matches(keyOf(i.mediaType, i.id), namesOf(i)))
    : visibleItems;
  const shownPlexItems = filtering
    ? (plexItems ?? []).filter((i) =>
        matches(keyOf(i.mediaType, i.tmdbId), i.title)
      )
    : (plexItems ?? []);
  const matchCount = shownItems.length + shownPlexItems.length;
  const loadedCount = visibleItems.length + (plexItems?.length ?? 0);

  // A filter keeps loading pages until it has enough to show, up to a limit
  // that can be raised: some lists never end.
  const [searchLimit, setSearchLimit] = useState(SEARCH_STEP);
  const [matchTarget, setMatchTarget] = useState(ENOUGH_MATCHES);
  useEffect(() => {
    setSearchLimit(SEARCH_STEP);
    setMatchTarget(ENOUGH_MATCHES);
  }, [debounced]);
  /** Still loading more of the list, looking for matches. */
  const searching =
    filtering &&
    !isReachingEnd &&
    matchCount < matchTarget &&
    loadedCount < searchLimit;
  useEffect(() => {
    if (searching && !isLoading) {
      onScrollBottom();
    }
  }, [searching, isLoading, loadedCount, onScrollBottom]);

  // Scrolling to the bottom loads more of an unfiltered list. While
  // filtering, loading is the filter's to decide, above: scrolling would
  // otherwise keep pulling in pages of titles that do not match.
  useVerticalScroll(
    onScrollBottom,
    !filtering && !isLoading && !isEmpty && !isReachingEnd
  );
  // Choosing titles to request together, as on every page of posters.
  const { selecting, statusOf, pick, selectButton, bar } = useBulkRequest({
    onDone: mutateParent,
  });

  const showControls = !isEmpty || filtering;

  // Counts each title as it is drawn, below.
  const renderedKeys = new Map<string, number>();

  return (
    <>
      {showControls && (
        <div className="mb-4 flex items-stretch gap-2">
          <div className="relative flex flex-1">
            <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100">
              <MagnifyingGlassIcon className="h-5 w-5" />
            </span>
            <input
              type="text"
              inputMode="search"
              enterKeyHint="search"
              name="list-filter"
              aria-label={intl.formatMessage(messages.filter)}
              placeholder={intl.formatMessage(messages.filterHint)}
              value={filter}
              maxLength={100}
              onChange={(e) => setFilter(e.target.value)}
              // Room for the clear button only while there is something to
              // clear, so the hint fits beside Select on a phone.
              className={`rounded-r-only text-ellipsis ${filter ? 'pr-9' : ''}`}
            />
            {filter && (
              <button
                type="button"
                aria-label={intl.formatMessage(messages.clearFilter)}
                onClick={() => setFilter('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            )}
          </div>
          {selectButton}
        </div>
      )}
      {filtering && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-400">
          <span>
            {intl.formatMessage(messages.matches, {
              matches: matchCount,
              loaded: loadedCount,
            })}
          </span>
        </div>
      )}
      {isEmpty && !filtering && (
        <div className="mt-64 w-full text-center text-2xl text-gray-400">
          {intl.formatMessage(globalMessages.noresults)}
        </div>
      )}
      {filtering && !matchCount && !isLoading && !pending && !searching && (
        <div className="mt-16 w-full text-center text-lg text-gray-400">
          {intl.formatMessage(messages.nomatch, { query: debounced.trim() })}
        </div>
      )}
      {/* Pages load ahead of the scroll; their posters start as they arrive. */}
      <EagerPosters.Provider value={true}>
        <ul className={`cards-vertical ${selecting ? 'pb-28' : ''}`}>
          {shownPlexItems.map((title, index) => {
            const key = keyOf(title.mediaType, title.tmdbId);
            return (
              <li key={`${title.ratingKey}-${index}`}>
                {pick(
                  key,
                  title.mediaType,
                  statusOf(key),
                  <TmdbTitleCard
                    id={title.tmdbId}
                    tmdbId={title.tmdbId}
                    type={title.mediaType}
                    isAddedToWatchlist={true}
                    canExpand
                    mutateParent={mutateParent}
                  />
                )}
              </li>
            );
          })}
          {shownItems.map((title) => {
            let titleCard: React.ReactNode;
            let status: MediaStatus | undefined;

            switch (title.mediaType) {
              case 'movie':
                status = statusOf(
                  keyOf('movie', title.id),
                  title.mediaInfo?.status
                );
                titleCard = (
                  <TitleCard
                    key={title.id}
                    id={title.id}
                    isAddedToWatchlist={
                      title.mediaInfo?.watchlists?.length ?? 0
                    }
                    image={title.posterPath}
                    status={status}
                    summary={title.overview}
                    title={title.title}
                    userScore={title.voteAverage}
                    year={title.releaseDate}
                    mediaType={title.mediaType}
                    inProgress={
                      (title.mediaInfo?.downloadStatus ?? []).length > 0
                    }
                    canExpand
                  />
                );
                break;
              case 'tv':
                status = statusOf(
                  keyOf('tv', title.id),
                  title.mediaInfo?.status
                );
                titleCard = (
                  <TitleCard
                    key={title.id}
                    id={title.id}
                    isAddedToWatchlist={
                      title.mediaInfo?.watchlists?.length ?? 0
                    }
                    image={title.posterPath}
                    status={status}
                    summary={title.overview}
                    title={title.name}
                    userScore={title.voteAverage}
                    year={title.firstAirDate}
                    mediaType={title.mediaType}
                    inProgress={
                      (title.mediaInfo?.downloadStatus ?? []).length > 0
                    }
                    canExpand
                  />
                );
                break;
              case 'collection':
                titleCard = (
                  <TitleCard
                    id={title.id}
                    image={title.posterPath}
                    summary={title.overview}
                    title={title.title}
                    mediaType={title.mediaType}
                    canExpand
                  />
                );
                break;
              case 'person':
                titleCard = (
                  <PersonCard
                    personId={title.id}
                    name={title.name}
                    profilePath={title.profilePath}
                    canExpand
                  />
                );
                break;
            }

            // Keyed by the title, not its place: when one drops out (it was
            // just requested, say) the cards after it keep their state and
            // images instead of all being rebuilt. A title listed twice,
            // as a search across pages can, is told apart by its count.
            const baseKey = keyOf(title.mediaType, title.id);
            const repeat = renderedKeys.get(baseKey) ?? 0;
            renderedKeys.set(baseKey, repeat + 1);

            return (
              <li key={repeat ? `${baseKey}#${repeat}` : baseKey}>
                {pick(
                  keyOf(title.mediaType, title.id),
                  title.mediaType,
                  status,
                  titleCard
                )}
              </li>
            );
          })}
          {isLoading &&
            !isReachingEnd &&
            !filtering &&
            [...Array(20)].map((_item, i) => (
              <li key={`placeholder-${i}`}>
                <TitleCard.Placeholder canExpand />
              </li>
            ))}
        </ul>
      </EagerPosters.Provider>
      {/*
        While filtering, only matches are shown: no placeholder cards for
        pages still loading, just a line saying the search is going on, or,
        once it stops, a way to look further down the list.
      */}
      {filtering &&
        (searching || isLoading || pending ? (
          <div className="mt-6 flex items-center justify-center gap-3 text-sm text-gray-400">
            <span className="h-5 w-5">
              <SmallLoadingSpinner />
            </span>
            {intl.formatMessage(messages.lookingThrough, {
              loaded: loadedCount,
            })}
          </div>
        ) : (
          !isReachingEnd && (
            <div className="mt-6 flex flex-col items-center gap-2 text-sm text-gray-400">
              <span>
                {intl.formatMessage(messages.lookedThrough, {
                  loaded: loadedCount,
                })}
              </span>
              <Button
                buttonSize="sm"
                onClick={() => {
                  setSearchLimit(loadedCount + SEARCH_STEP);
                  setMatchTarget(matchCount + ENOUGH_MATCHES);
                }}
              >
                {intl.formatMessage(messages.searchFurther)}
              </Button>
            </div>
          )
        ))}
      {bar([
        ...shownPlexItems.map(
          (i) =>
            [keyOf(i.mediaType, i.tmdbId), i.mediaType, undefined] as [
              string,
              string,
              MediaStatus | undefined,
            ]
        ),
        ...shownItems.map(
          (i) =>
            [
              keyOf(i.mediaType, i.id),
              i.mediaType,
              i.mediaType === 'movie' || i.mediaType === 'tv'
                ? i.mediaInfo?.status
                : undefined,
            ] as [string, string, MediaStatus | undefined]
        ),
      ])}
    </>
  );
};

export default ListView;
