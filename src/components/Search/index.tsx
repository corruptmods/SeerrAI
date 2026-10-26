import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import MusicSearchResults from '@app/components/Music/MusicSearchResults';
import type { SearchType } from '@app/components/Search/searchType';
import {
  musicBelowTitles,
  musicInAll,
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
  inAll,
}: {
  query: string;
  type: 'all' | 'movie' | 'tv';
  inAll: boolean;
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

  const music = musicBelowTitles(type, inAll, !isLoadingInitialData);

  return (
    <>
      <ListView
        items={titles}
        // With music below, it says when nothing at all was found.
        isEmpty={isEmpty && !music}
        isLoading={
          isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
        }
        isReachingEnd={isReachingEnd}
        onScrollBottom={fetchMore}
      />
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
        {TYPES.filter((t) => t.type !== 'music' || musicOn).map((t) => (
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
                ? 'bg-accent text-on-accent'
                : 'bg-surface text-default ring-1 ring-subtle hover:text-strong'
            }`}
          >
            {intl.formatMessage(globalMessages[t.label])}
          </Link>
        ))}
      </nav>
      {type === 'music' ? (
        <MusicSearchResults query={query} />
      ) : (
        <TitleResults key={type} query={query} type={type} inAll={inAll} />
      )}
    </>
  );
};

export default Search;
