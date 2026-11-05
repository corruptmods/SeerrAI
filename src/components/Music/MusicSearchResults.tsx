import ArtistCard from '@app/components/Music/ArtistCard';
import MusicCard from '@app/components/Music/MusicCard';
import MusicSlider from '@app/components/Music/MusicSlider';
import SongResults from '@app/components/Music/SongResults';
import useDebouncedState from '@app/hooks/useDebouncedState';
import useFeature from '@app/hooks/useFeature';
import useSettings from '@app/hooks/useSettings';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import type { MusicSearchResponse } from '@server/models/Music';
import { useEffect } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Music.MusicSearchResults', {
  artists: 'Artists',
  albums: 'Albums',
  busy: 'MusicBrainz is busy right now; music results will come with your next search.',
  failed: 'MusicBrainz did not answer. Try again in a moment.',
});

/**
 * MusicBrainz artist and album results, with a longer debounce than films as
 * MusicBrainz allows one request a second per server. A card grid, or with
 * `rows`, Artists and Albums rows under the films in All. Songs follow when
 * song requests are on.
 */
const MusicSearchResults = ({
  query,
  rows = false,
  nothingAbove = false,
}: {
  query: string;
  rows?: boolean;
  /** In rows: no films or series were found either. */
  nothingAbove?: boolean;
}) => {
  const intl = useIntl();
  const musicOn = useFeature('music');
  const { currentSettings } = useSettings();
  const [, settled, setQuery] = useDebouncedState(query.trim(), 500);

  useEffect(() => {
    setQuery(query.trim());
  }, [query, setQuery]);

  const { data, error, isLoading } = useSWR<MusicSearchResponse>(
    musicOn && settled
      ? `/api/v1/music/search?query=${encodeURIComponent(settled)}`
      : null,
    { revalidateOnFocus: false }
  );

  if (!musicOn || !query.trim()) {
    return null;
  }

  // Music was turned off since the page loaded.
  if (error?.response?.status === 403) {
    return null;
  }

  // Superseded by this person's newer search (another tab): retried, and
  // shown as waiting meanwhile.
  const replaced = error?.response?.status === 409;

  if (error && !replaced) {
    return (
      <p className="mt-8 text-center text-muted">
        {error.response?.status === 503
          ? intl.formatMessage(messages.busy)
          : intl.formatMessage(messages.failed)}
      </p>
    );
  }

  const waiting = !data && (isLoading || replaced || settled !== query.trim());
  // Fetched alongside: the server shares the search and queries MusicBrainz
  // for songs right after.
  const songs = currentSettings.musicSongs &&
    settled &&
    settled === query.trim() && <SongResults query={settled} />;

  if (rows) {
    // Empty rows are left out; "nothing found" only when there were no films
    // or series either.
    if (
      nothingAbove &&
      !waiting &&
      !data?.artists?.length &&
      !data?.albums?.length
    ) {
      return (
        <div className="mt-64 w-full text-center text-2xl text-muted">
          {intl.formatMessage(globalMessages.noresults)}
        </div>
      );
    }
    return (
      <div className="mt-8 space-y-6">
        <MusicSlider
          sliderKey="search-artists"
          title={intl.formatMessage(messages.artists)}
          items={data?.artists}
          isLoading={waiting}
        />
        <MusicSlider
          sliderKey="search-albums"
          title={intl.formatMessage(messages.albums)}
          items={data?.albums}
          isLoading={waiting}
        />
        {songs}
      </div>
    );
  }

  if (waiting) {
    return (
      <div className="space-y-6">
        <ul className="cards-vertical" aria-busy="true">
          {[...Array(10)].map((_, i) => (
            <li key={`placeholder-${i}`}>
              <MusicCard.Placeholder canExpand />
            </li>
          ))}
        </ul>
        {songs}
      </div>
    );
  }

  const artists = data?.artists ?? [];
  const albums = data?.albums ?? [];

  if (!artists.length && !albums.length) {
    return (
      <div className="mt-16 w-full text-center text-2xl text-muted">
        {intl.formatMessage(globalMessages.noresults)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {artists.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-bold text-gray-200">
            {intl.formatMessage(messages.artists)}
          </h2>
          <ul className="cards-vertical">
            {artists.map((artist) => (
              <li key={artist.id}>
                <ArtistCard artist={artist} canExpand />
              </li>
            ))}
          </ul>
        </section>
      )}
      {albums.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-bold text-gray-200">
            {intl.formatMessage(messages.albums)}
          </h2>
          <ul className="cards-vertical">
            {albums.map((album) => (
              <li key={album.id}>
                <MusicCard album={album} canExpand />
              </li>
            ))}
          </ul>
        </section>
      )}
      {songs}
    </div>
  );
};

export default MusicSearchResults;
