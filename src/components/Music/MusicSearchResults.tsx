import MusicSlider from '@app/components/Music/MusicSlider';
import useDebouncedState from '@app/hooks/useDebouncedState';
import useFeature from '@app/hooks/useFeature';
import defineMessages from '@app/utils/defineMessages';
import type { MusicSearchResponse } from '@server/models/Music';
import { useEffect } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Music.MusicSearchResults', {
  artists: 'Artists',
  albums: 'Albums',
  busy: 'MusicBrainz is busy right now; music results will come with your next search.',
});

/**
 * Music in search results: artists and albums from MusicBrainz, loaded on
 * their own and after a longer pause in typing than films and series, as
 * MusicBrainz answers one request a second for the whole server.
 */
const MusicSearchResults = ({ query }: { query: string }) => {
  const intl = useIntl();
  const musicOn = useFeature('music');
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

  const waiting = isLoading || settled !== query.trim();

  if (error) {
    return error.response?.status === 503 ? (
      <p className="mb-4 text-sm text-gray-400">
        {intl.formatMessage(messages.busy)}
      </p>
    ) : null;
  }

  return (
    <div className="mb-6">
      <MusicSlider
        sliderKey="search-artists"
        title={intl.formatMessage(messages.artists)}
        items={data?.artists}
        isLoading={waiting && !data}
      />
      <MusicSlider
        sliderKey="search-albums"
        title={intl.formatMessage(messages.albums)}
        items={data?.albums}
        isLoading={waiting && !data}
      />
    </div>
  );
};

export default MusicSearchResults;
