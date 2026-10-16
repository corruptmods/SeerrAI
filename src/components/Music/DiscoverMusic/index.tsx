import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageSearch from '@app/components/Common/PageSearch';
import PageTitle from '@app/components/Common/PageTitle';
import ArtistCard from '@app/components/Music/ArtistCard';
import MusicCard from '@app/components/Music/MusicCard';
import MusicSearchResults from '@app/components/Music/MusicSearchResults';
import MusicSlider from '@app/components/Music/MusicSlider';
import {
  MUSIC_ROWS,
  musicRowLink,
  musicRowUrl,
} from '@app/components/Music/musicRows';
import { musicSearchPlaces } from '@app/components/Search/searchType';
import useFeature from '@app/hooks/useFeature';
import useSettings from '@app/hooks/useSettings';
import useVerticalScroll from '@app/hooks/useVerticalScroll';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type {
  MusicAlbumResult,
  MusicArtistResult,
  MusicPage,
} from '@server/models/Music';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWRInfinite from 'swr/infinite';

const messages = defineMessages('components.Music.DiscoverMusic', {
  music: 'Music',
  nothingYet: 'Nothing here yet.',
  search: 'Search music for an artist or album',
  searchPlaceholder: 'Artist or album',
  clearSearch: 'Clear search',
});

const SEARCH_KEY = 'music-search';
const readSearch = (): string => {
  try {
    return sessionStorage.getItem(SEARCH_KEY) ?? '';
  } catch {
    return '';
  }
};

/**
 * The Music page's own search: artists and albums only, shown in place of
 * the rows while there is something in it. Kept for the rest of the visit,
 * like the filter on the Movies and Series pages, so it is still there
 * after opening an artist and coming back.
 */
const useMusicSearch = (): [string, (value: string) => void] => {
  const [search, setSearch] = useState('');
  useEffect(() => {
    setSearch(readSearch());
  }, []);
  const update = useCallback((value: string) => {
    setSearch(value);
    try {
      if (value.trim()) {
        sessionStorage.setItem(SEARCH_KEY, value);
      } else {
        sessionStorage.removeItem(SEARCH_KEY);
      }
    } catch {
      // Not kept past this page, which is all that is lost.
    }
  }, []);
  return [search, update];
};

type Item = MusicAlbumResult | MusicArtistResult;

/** One row's whole list, a page at a time as the page is scrolled. */
const MusicGrid = ({ url }: { url: string }) => {
  const intl = useIntl();
  const { data, error, size, setSize, isValidating } = useSWRInfinite<
    MusicPage<Item>
  >((index, previous: MusicPage<Item> | null) =>
    previous && index + 1 > previous.totalPages
      ? null
      : `${url}?page=${index + 1}`
  );

  const items = (data ?? []).flatMap((page) => page.results ?? []);
  const reachedEnd = !!data && size >= (data[data.length - 1]?.totalPages ?? 1);
  const loading =
    (!data && !error) || (isValidating && size > (data?.length ?? 0));

  useVerticalScroll(() => setSize(size + 1), !reachedEnd && !loading);

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  return (
    <>
      <ul className="cards-vertical">
        {items.map((item) => (
          <li key={`${item.mediaType}-${item.id}`}>
            {item.mediaType === 'artist' ? (
              <ArtistCard artist={item} canExpand />
            ) : (
              <MusicCard album={item} canExpand />
            )}
          </li>
        ))}
        {loading &&
          [...Array(10)].map((_, i) => (
            <li key={`placeholder-${i}`}>
              <MusicCard.Placeholder canExpand />
            </li>
          ))}
      </ul>
      {!loading && !items.length && (
        <div className="mt-16 w-full text-center text-lg text-gray-400">
          {intl.formatMessage(messages.nothingYet)}
        </div>
      )}
    </>
  );
};

/**
 * Music to discover: every music row, or one of them in full
 * (/discover/music?show=new-releases).
 */
const DiscoverMusic = () => {
  const intl = useIntl();
  const router = useRouter();
  const musicOn = useFeature('music');
  const { currentSettings } = useSettings();
  const row = MUSIC_ROWS.find((r) => r.show === router.query.show);
  const [search, setSearch] = useMusicSearch();
  // The search box is there unless an admin took it away (Settings →
  // Music); then a search kept from earlier in the visit is ignored too.
  const canSearch = musicSearchPlaces(
    musicOn,
    currentSettings.musicSearch
  ).musicPage;
  const searching = canSearch && !!search.trim();

  if (!musicOn) {
    return <ErrorPage statusCode={404} />;
  }
  if (!router.isReady) {
    return <LoadingSpinner />;
  }

  const title = row
    ? intl.formatMessage(row.title)
    : intl.formatMessage(messages.music);

  return (
    <>
      <PageTitle
        title={row ? [title, intl.formatMessage(messages.music)] : title}
      />
      <div className="mb-4 mt-1">
        <Header>{title}</Header>
      </div>
      {canSearch && (
        <div className="mb-5 flex">
          <PageSearch
            name="music-search"
            value={search}
            onChange={setSearch}
            label={intl.formatMessage(messages.search)}
            placeholder={intl.formatMessage(messages.searchPlaceholder)}
            clearLabel={intl.formatMessage(messages.clearSearch)}
          />
        </div>
      )}
      {searching ? (
        <MusicSearchResults query={search} />
      ) : row ? (
        <MusicGrid url={musicRowUrl(row)} />
      ) : (
        MUSIC_ROWS.map((r) => (
          <MusicSlider
            key={r.show}
            sliderKey={`music-page-${r.show}`}
            title={intl.formatMessage(r.title)}
            url={musicRowUrl(r)}
            linkUrl={musicRowLink(r)}
          />
        ))
      )}
    </>
  );
};

export default DiscoverMusic;
