import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import MusicSearchResults from '@app/components/Music/MusicSearchResults';
import type { SearchSort, SearchType } from '@app/components/Search/searchType';
import {
  SORTED_PAGES,
  effectiveSearchSort,
  musicBelowTitles,
  musicInAll,
  searchSort,
  searchSortsFor,
  searchType,
  sortSearchResults,
} from '@app/components/Search/searchType';
import useDiscover from '@app/hooks/useDiscover';
import useFeature from '@app/hooks/useFeature';
import useSettings from '@app/hooks/useSettings';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { BarsArrowDownIcon } from '@heroicons/react/24/solid';
import type {
  CollectionResult,
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Search', {
  search: 'Search',
  searchresults: 'Search Results',
  show: 'Show',
  people: 'People',
  sortRelevance: 'Best match',
  sortNewest: 'Newest first',
  sortOldest: 'Oldest first',
  sortRating: 'Highest rated',
  sortPopularity: 'Most popular',
  sortedLoaded: 'Sorted within the results loaded so far ({count}).',
  loadMore: 'Load more and sort again',
});

const TYPES: {
  type: SearchType;
  label: keyof typeof globalMessages | 'people';
}[] = [
  { type: 'all', label: 'all' },
  { type: 'movie', label: 'movies' },
  { type: 'tv', label: 'tvshows' },
  { type: 'person', label: 'people' },
  { type: 'music', label: 'music' },
];

const SORT_LABELS = {
  relevance: messages.sortRelevance,
  newest: messages.sortNewest,
  oldest: messages.sortOldest,
  rating: messages.sortRating,
  popularity: messages.sortPopularity,
} as const;

/**
 * Film and series results (plus collections and people in All), with music
 * below in All when an admin enabled it.
 */
const TitleResults = ({
  query,
  type,
  sort,
  inAll,
}: {
  query: string;
  type: 'all' | 'movie' | 'tv' | 'person';
  sort: SearchSort;
  inAll: boolean;
}) => {
  const intl = useIntl();
  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    pagesLoaded,
    fetchMore,
    error,
  } = useDiscover<MovieResult | TvResult | PersonResult | CollectionResult>(
    `/api/v1/search`,
    type === 'all' ? { query } : { query, type },
    { hideAvailable: false, hideBlocklisted: false, hideRequested: false }
  );

  // TMDB only ranks by relevance: another order sorts what's loaded, so a
  // few pages load first and scrolling no longer adds more on its own.
  const sorted = sort !== 'relevance';
  const sortReady =
    !sorted || !!error || isReachingEnd || pagesLoaded >= SORTED_PAGES;
  useEffect(() => {
    if (!sortReady && !isLoadingMore && pagesLoaded > 0) {
      fetchMore();
    }
    // fetchMore is new each render; the page count decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortReady, isLoadingMore, pagesLoaded]);
  const shown = useMemo(
    () => (sorted ? sortSearchResults(titles, sort) : titles),
    [sorted, titles, sort]
  );

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  const music = musicBelowTitles(type, inAll, !isLoadingInitialData);

  return (
    <>
      <ListView
        // Sorted results show once their pages are in, so they don't reshuffle.
        items={sortReady ? shown : []}
        // With music below, the music results report when nothing was found.
        isEmpty={isEmpty && !music}
        isLoading={
          !sortReady ||
          isLoadingInitialData ||
          (isLoadingMore && (titles?.length ?? 0) > 0)
        }
        isReachingEnd={sorted ? sortReady : isReachingEnd}
        onScrollBottom={fetchMore}
      />
      {sorted && sortReady && !isReachingEnd && titles.length > 0 && (
        <div className="mt-6 flex flex-col items-center gap-2 text-sm text-muted">
          <span>
            {intl.formatMessage(messages.sortedLoaded, {
              count: titles.length,
            })}
          </span>
          <Button
            buttonSize="sm"
            disabled={isLoadingMore}
            onClick={() => fetchMore()}
          >
            {isLoadingMore ? (
              <span className="h-4 w-4">
                <SmallLoadingSpinner />
              </span>
            ) : null}
            <span>{intl.formatMessage(messages.loadMore)}</span>
          </Button>
        </div>
      )}
      {music && (
        <MusicSearchResults query={query} rows nothingAbove={!!isEmpty} />
      )}
    </>
  );
};

const Search = () => {
  const intl = useIntl();
  const router = useRouter();
  const { currentSettings } = useSettings();
  const musicOn = useFeature('music');
  const inAll = musicInAll(musicOn, currentSettings.musicSearch);
  const query =
    typeof router.query.query === 'string' ? router.query.query : '';
  const type = searchType(router.query.type, musicOn);
  const askedSort = searchSort(router.query.sort);
  const sort = effectiveSearchSort(askedSort, type);
  const sorts = searchSortsFor(type);

  // The address for a kind and order; defaults are left out.
  const addressQuery = (to: SearchType, order: SearchSort) => ({
    query,
    ...(to !== 'all' && { type: to }),
    ...(effectiveSearchSort(order, to) !== 'relevance' && { sort: order }),
  });

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.search)} />
      <div className="mb-4 mt-1">
        <Header>{intl.formatMessage(messages.searchresults)}</Header>
      </div>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Links, so the type is in the URL for history and sharing. */}
        <nav
          aria-label={intl.formatMessage(messages.show)}
          className="flex flex-wrap gap-2"
        >
          {TYPES.filter((t) => t.type !== 'music' || musicOn).map((t) => (
            <Link
              key={t.type}
              href={{
                pathname: '/search',
                // The order carries over where it fits.
                query: addressQuery(t.type, askedSort),
              }}
              aria-current={type === t.type ? 'page' : undefined}
              scroll={false}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                type === t.type
                  ? 'bg-accent text-on-accent'
                  : 'bg-surface text-default ring-1 ring-subtle hover:text-strong'
              }`}
            >
              {intl.formatMessage(
                t.label === 'people' ? messages.people : globalMessages[t.label]
              )}
            </Link>
          ))}
        </nav>
        {sorts.length > 1 && (
          <div className="flex w-full min-w-0 sm:w-[12.5rem]">
            <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
              <BarsArrowDownIcon className="h-6 w-6" />
            </span>
            <select
              id="searchSort"
              name="searchSort"
              aria-label={intl.formatMessage(globalMessages.sortBy)}
              value={sort}
              onChange={(e) =>
                router.replace(
                  {
                    pathname: '/search',
                    query: addressQuery(type, e.target.value as SearchSort),
                  },
                  undefined,
                  { scroll: false }
                )
              }
              className="rounded-r-only pr-8"
            >
              {sorts.map((option) => (
                <option key={option} value={option}>
                  {intl.formatMessage(SORT_LABELS[option])}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {type === 'music' ? (
        <MusicSearchResults query={query} />
      ) : (
        <TitleResults
          key={type}
          query={query}
          type={type}
          sort={sort}
          inAll={inAll}
        />
      )}
    </>
  );
};

export default Search;
