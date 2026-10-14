import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import ArtistCard from '@app/components/Music/ArtistCard';
import MusicCard from '@app/components/Music/MusicCard';
import MusicSlider from '@app/components/Music/MusicSlider';
import {
  MUSIC_ROWS,
  musicRowLink,
  musicRowUrl,
} from '@app/components/Music/musicRows';
import useFeature from '@app/hooks/useFeature';
import useVerticalScroll from '@app/hooks/useVerticalScroll';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type {
  MusicAlbumResult,
  MusicArtistResult,
  MusicPage,
} from '@server/models/Music';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';
import useSWRInfinite from 'swr/infinite';

const messages = defineMessages('components.Music.DiscoverMusic', {
  music: 'Music',
  nothingYet: 'Nothing here yet.',
  searchHint: 'Search for any artist or album from the search bar.',
});

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
  const row = MUSIC_ROWS.find((r) => r.show === router.query.show);

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
      <div className="mb-5 mt-1">
        <Header
          subtext={row ? undefined : intl.formatMessage(messages.searchHint)}
        >
          {title}
        </Header>
      </div>
      {row ? (
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
