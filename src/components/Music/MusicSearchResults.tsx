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
 * Music found for a search: artists and albums from MusicBrainz, after a
 * longer pause in typing than films and series, as MusicBrainz answers one
 * request a second for the whole server. Shown where music is asked for
 * (Search's Music, the Music page) as a page of cards, or, with `rows`, as
 * an Artists row and an Albums row below the films and series in All. Once
 * songs can be asked for one at a time, their songs come after.
 */
const MusicSearchResults = ({
  query,
  rows = false,
}: {
  query: string;
  rows?: boolean;
}) => {
  const intl = useIntl();
  const musicOn = useFeature('music');
  const { currentSettings } = useSettings();
  const [, settled, setQuery] = useDebouncedState(query.trim(), 700);

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

  // Turned off since the page loaded: there is no music to show.
  if (error?.response?.status === 403) {
    return null;
  }

  if (error) {
    return (
      <p className="mt-8 text-center text-muted">
        {error.response?.status === 503
          ? intl.formatMessage(messages.busy)
          : intl.formatMessage(messages.failed)}
      </p>
    );
  }

  const waiting = !data && (isLoading || settled !== query.trim());
  // Asked for once the artists and albums are in: the same search, then
  // one more, as MusicBrainz takes one request a second.
  const songs = currentSettings.musicSongs && data && !waiting && (
    <SongResults query={settled} />
  );

  if (rows) {
    // Below the films and series: a row with nothing in it is left out, and
    // nothing found says nothing, as the films and series above have
    // already answered the search.
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
      <ul className="cards-vertical" aria-busy="true">
        {[...Array(10)].map((_, i) => (
          <li key={`placeholder-${i}`}>
            <MusicCard.Placeholder canExpand />
          </li>
        ))}
      </ul>
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
