import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageSearch from '@app/components/Common/PageSearch';
import PageTitle from '@app/components/Common/PageTitle';
import ArtistCard from '@app/components/Music/ArtistCard';
import type { MusicPageHint } from '@app/components/Music/DiscoverMusic/emptyPage';
import { emptyMusicPage } from '@app/components/Music/DiscoverMusic/emptyPage';
import MusicCard from '@app/components/Music/MusicCard';
import MusicSearchResults from '@app/components/Music/MusicSearchResults';
import MusicSlider from '@app/components/Music/MusicSlider';
import {
  MUSIC_ROWS,
  PERSONAL_MUSIC_ROWS,
  musicRowLink,
  musicRowUrl,
} from '@app/components/Music/musicRows';
import useFeature from '@app/hooks/useFeature';
import { Permission, useUser } from '@app/hooks/useUser';
import useVerticalScroll from '@app/hooks/useVerticalScroll';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { MusicalNoteIcon } from '@heroicons/react/24/outline';
import type {
  MusicAlbumResult,
  MusicArtistResult,
  MusicPage,
} from '@server/models/Music';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';

const messages = defineMessages('components.Music.DiscoverMusic', {
  music: 'Music',
  nothingYet: 'Nothing here yet.',
  search: 'Search music for an artist or album',
  searchPlaceholder: 'Artist or album',
  clearSearch: 'Clear search',
  emptySearch: 'Search above for any artist or album.',
  emptyListenBrainz:
    'Turn on New and Popular Music in <link>Settings → Music</link>.',
  emptyAlbumsHere: 'Music shows here once albums are on your server.',
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
        <div className="mt-16 w-full text-center text-lg text-muted">
          {intl.formatMessage(messages.nothingYet)}
        </div>
      )}
    </>
  );
};

/**
 * Said in place of the rows when none of them has anything, so the page is
 * not blank below its search box: search above, and, for admins, what
 * would fill it.
 */
const NothingYet = ({ hints }: { hints: MusicPageHint[] }) => {
  const intl = useIntl();
  const said: Record<MusicPageHint, ReactNode> = {
    listenBrainz: intl.formatMessage(messages.emptyListenBrainz, {
      link: (text: ReactNode) => (
        <Link
          key="link"
          href="/settings/music"
          className="font-medium text-accent-soft hover:underline light:text-accent-text"
        >
          {text}
        </Link>
      ),
    }),
    albumsHere: intl.formatMessage(messages.emptyAlbumsHere),
  };
  return (
    <div className="mx-auto mt-10 max-w-md px-4 text-center">
      <MusicalNoteIcon className="mx-auto h-10 w-10 text-gray-500" />
      <p className="mt-3 text-lg font-semibold text-gray-200">
        {intl.formatMessage(messages.nothingYet)}
      </p>
      <p className="mt-1 text-sm text-muted">
        {intl.formatMessage(messages.emptySearch)}
      </p>
      {hints.length > 0 && (
        <ul className="mt-5 space-y-2 border-t border-subtle pt-5 text-sm text-muted">
          {hints.map((hint) => (
            <li key={hint}>{said[hint]}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

/** Each person's own rows first, then everyone's. */
const PAGE_ROWS = [...PERSONAL_MUSIC_ROWS, ...MUSIC_ROWS];

/**
 * Music to discover: every music row, or one of them in full
 * (/discover/music?show=new-releases).
 */
const DiscoverMusic = () => {
  const intl = useIntl();
  const router = useRouter();
  const musicOn = useFeature('music');
  const { hasPermission } = useUser();
  const admin = hasPermission(Permission.ADMIN);
  const row = PAGE_ROWS.find((r) => r.show === router.query.show);
  const [search, setSearch] = useMusicSearch();
  const searching = !!search.trim();

  // How many each row came back with, to tell when every one is empty.
  const [rowCounts, setRowCounts] = useState<Record<string, number>>({});
  const rowLoaded = useCallback(
    (show: string, count: number) =>
      setRowCounts((counts) =>
        counts[show] === count ? counts : { ...counts, [show]: count }
      ),
    []
  );
  const rowStates = PAGE_ROWS.map((r) => ({
    loaded: r.show in rowCounts,
    count: rowCounts[r.show] ?? 0,
  }));
  // Only asked for once every row is empty, and only admins may read it.
  const { data: sources } = useSWR<{ listenBrainz: boolean }>(
    admin && emptyMusicPage(rowStates, false, undefined)
      ? '/api/v1/settings/music'
      : null
  );
  const nothing = emptyMusicPage(rowStates, admin, sources?.listenBrainz);

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
      {searching ? (
        <MusicSearchResults query={search} />
      ) : row ? (
        <MusicGrid url={musicRowUrl(row)} />
      ) : (
        <>
          {PAGE_ROWS.map((r) => (
            <MusicSlider
              key={r.show}
              sliderKey={`music-page-${r.show}`}
              title={intl.formatMessage(r.title)}
              url={musicRowUrl(r)}
              linkUrl={musicRowLink(r)}
              onLoaded={(count) => rowLoaded(r.show, count)}
            />
          ))}
          {nothing && <NothingYet hints={nothing.hints} />}
        </>
      )}
    </>
  );
};

export default DiscoverMusic;
