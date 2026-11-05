import Button from '@app/components/Common/Button';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import PageSearch from '@app/components/Common/PageSearch';
import PersonCard from '@app/components/PersonCard';
import TitleCard from '@app/components/TitleCard';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import useBulkRequest, { bulkKey } from '@app/hooks/useBulkRequest';
import useSearchText from '@app/hooks/useSearchText';
import { Permission, useUser } from '@app/hooks/useUser';
import useVerticalScroll from '@app/hooks/useVerticalScroll';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
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
import Link from 'next/link';
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
  searchAllMovies: 'Search all movies for “{query}”',
  searchAllSeries: 'Search all series for “{query}”',
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
  /**
   * On the Movies and Series pages: the filter, which only searches this
   * list, then offers to search every title of this type.
   */
  searchAllType?: 'movie' | 'tv';
};

/** Titles a filter searches before asking to go further. */
const SEARCH_STEP = 400;
/** Matches after which a filter stops loading more on its own. */
const ENOUGH_MATCHES = 24;
const keyOf = bulkKey;

/** A title's names from the list item, before any details load. */
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
 * A grid of posters (Discover, search, watchlists, recommendations) with a
 * filter by title, cast, character, crew, genre and keyword, and bulk
 * request.
 */
const ListView = ({
  items,
  isEmpty,
  isLoading,
  onScrollBottom,
  isReachingEnd,
  plexItems,
  mutateParent,
  searchAllType,
}: ListViewProps) => {
  const intl = useIntl();
  const router = useRouter();
  const { hasPermission } = useUser();

  const blocklistVisibility = hasPermission(
    [Permission.MANAGE_BLOCKLIST, Permission.VIEW_BLOCKLIST],
    { type: 'or' }
  );
  // Kept per page (path, not query) for the session, so it survives opening a
  // title and coming back, and changing the page's own filters or sort.
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
      // Storage unavailable: the filter just isn't kept.
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

  // A filter loads pages until it has enough matches, up to a raisable limit:
  // some lists never end.
  const [searchLimit, setSearchLimit] = useState(SEARCH_STEP);
  const [matchTarget, setMatchTarget] = useState(ENOUGH_MATCHES);
  useEffect(() => {
    setSearchLimit(SEARCH_STEP);
    setMatchTarget(ENOUGH_MATCHES);
  }, [debounced]);
  /** Loading more of the list to find matches. */
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

  // Infinite scroll only while unfiltered; while filtering the filter decides
  // (above), or scrolling would keep loading non-matching pages.
  useVerticalScroll(
    onScrollBottom,
    !filtering && !isLoading && !isEmpty && !isReachingEnd
  );
  const { selecting, statusOf, pick, selectButton, bar } = useBulkRequest({
    onDone: mutateParent,
  });

  const showControls = !isEmpty || filtering;

  // Render count per title key, to tell duplicates apart.
  const renderedKeys = new Map<string, number>();

  return (
    <>
      {showControls && (
        <div className="mb-4 flex items-stretch gap-2">
          <PageSearch
            name="list-filter"
            value={filter}
            onChange={setFilter}
            label={intl.formatMessage(messages.filter)}
            placeholder={intl.formatMessage(messages.filterHint)}
            clearLabel={intl.formatMessage(messages.clearFilter)}
          />
          {selectButton}
        </div>
      )}
      {filtering && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <span>
            {intl.formatMessage(messages.matches, {
              matches: matchCount,
              loaded: loadedCount,
            })}
          </span>
          {searchAllType && (
            <Link
              href={{
                pathname: '/search',
                query: { query: debounced.trim(), type: searchAllType },
              }}
              className="font-medium text-indigo-400 hover:text-indigo-300 light:text-accent-text light:hover:text-accent-text"
            >
              {intl.formatMessage(
                searchAllType === 'movie'
                  ? messages.searchAllMovies
                  : messages.searchAllSeries,
                { query: debounced.trim() }
              )}
            </Link>
          )}
        </div>
      )}
      {isEmpty && !filtering && (
        <div className="mt-64 w-full text-center text-2xl text-muted">
          {intl.formatMessage(globalMessages.noresults)}
        </div>
      )}
      {filtering && !matchCount && !isLoading && !pending && !searching && (
        <div className="mt-16 w-full text-center text-lg text-muted">
          {intl.formatMessage(messages.nomatch, { query: debounced.trim() })}
        </div>
      )}
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
                />,
                title.title
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
                  isAddedToWatchlist={title.mediaInfo?.watchlists?.length ?? 0}
                  image={title.posterPath}
                  backdrop={title.backdropPath}
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
              status = statusOf(keyOf('tv', title.id), title.mediaInfo?.status);
              titleCard = (
                <TitleCard
                  key={title.id}
                  id={title.id}
                  isAddedToWatchlist={title.mediaInfo?.watchlists?.length ?? 0}
                  image={title.posterPath}
                  backdrop={title.backdropPath}
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
                  backdrop={title.backdropPath}
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

          // Keyed by title, not index, so cards after a removed one keep
          // their state and images. A title listed twice gets its count.
          const baseKey = keyOf(title.mediaType, title.id);
          const repeat = renderedKeys.get(baseKey) ?? 0;
          renderedKeys.set(baseKey, repeat + 1);

          return (
            <li key={repeat ? `${baseKey}#${repeat}` : baseKey}>
              {pick(
                keyOf(title.mediaType, title.id),
                title.mediaType,
                status,
                titleCard,
                title.mediaType === 'movie' || title.mediaType === 'collection'
                  ? title.title
                  : title.name
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
      {/*
        While filtering, no placeholder cards: a searching line, or once it
        stops, a way to search further.
      */}
      {filtering &&
        (searching || isLoading || pending ? (
          <div className="mt-6 flex items-center justify-center gap-3 text-sm text-muted">
            <span className="h-5 w-5">
              <SmallLoadingSpinner />
            </span>
            {intl.formatMessage(messages.lookingThrough, {
              loaded: loadedCount,
            })}
          </div>
        ) : (
          !isReachingEnd && (
            <div className="mt-6 flex flex-col items-center gap-2 text-sm text-muted">
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
