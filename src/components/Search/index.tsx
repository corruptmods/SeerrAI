import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import MusicSearchResults from '@app/components/Music/MusicSearchResults';
import type {
  MusicSearchPlaces,
  SearchType,
} from '@app/components/Search/searchType';
import {
  musicBelowTitles,
  musicSearchPlaces,
  searchType,
} from '@app/components/Search/searchType';
import useDiscover from '@app/hooks/useDiscover';
import useFeature from '@app/hooks/useFeature';
import useSettings from '@app/hooks/useSettings';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type {
  CollectionResult,
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Search', {
  search: 'Search',
  searchresults: 'Search Results',
  show: 'Show',
});

const TYPES: { type: SearchType; label: keyof typeof globalMessages }[] = [
  { type: 'all', label: 'all' },
  { type: 'movie', label: 'movies' },
  { type: 'tv', label: 'tvshows' },
  { type: 'music', label: 'music' },
];

/**
 * Films and series (and, for everything, collections and people), with
 * music below them in All when an admin chose that.
 */
const TitleResults = ({
  query,
  type,
  music,
}: {
  query: string;
  type: 'all' | 'movie' | 'tv';
  music: MusicSearchPlaces;
}) => {
  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<MovieResult | TvResult | PersonResult | CollectionResult>(
    `/api/v1/search`,
    type === 'all' ? { query } : { query, type },
    { hideAvailable: false, hideBlocklisted: false, hideRequested: false }
  );

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  return (
    <>
      <ListView
        items={titles}
        isEmpty={isEmpty}
        isLoading={
          isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
        }
        isReachingEnd={isReachingEnd}
        onScrollBottom={fetchMore}
      />
      {musicBelowTitles(type, music, !isLoadingInitialData) && (
        <MusicSearchResults query={query} rows />
      )}
    </>
  );
};

const Search = () => {
  const intl = useIntl();
  const router = useRouter();
  const { currentSettings } = useSettings();
  const music = musicSearchPlaces(
    useFeature('music'),
    currentSettings.musicSearch
  );
  const query =
    typeof router.query.query === 'string' ? router.query.query : '';
  const type = searchType(router.query.type, music.chip);

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.search)} />
      <div className="mb-4 mt-1">
        <Header>{intl.formatMessage(messages.searchresults)}</Header>
      </div>
      {/* Links, so the kind is in the address: back, forward and sharing
          keep it. */}
      <nav
        aria-label={intl.formatMessage(messages.show)}
        className="mb-5 flex flex-wrap gap-2"
      >
        {TYPES.filter((t) => t.type !== 'music' || music.chip).map((t) => (
          <Link
            key={t.type}
            href={{
              pathname: '/search',
              query: t.type === 'all' ? { query } : { query, type: t.type },
            }}
            aria-current={type === t.type ? 'page' : undefined}
            scroll={false}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
              type === t.type
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-800 text-gray-300 ring-1 ring-gray-700 hover:text-white'
            }`}
          >
            {intl.formatMessage(globalMessages[t.label])}
          </Link>
        ))}
      </nav>
      {type === 'music' ? (
        <MusicSearchResults query={query} />
      ) : (
        <TitleResults key={type} query={query} type={type} music={music} />
      )}
    </>
  );
};

export default Search;
