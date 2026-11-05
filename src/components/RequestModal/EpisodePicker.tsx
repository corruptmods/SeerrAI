import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import StatusBadgeMini from '@app/components/Common/StatusBadgeMini';
import defineMessages from '@app/utils/defineMessages';
import { MediaStatus } from '@server/constants/media';
import type { SeasonWithEpisodes } from '@server/models/Tv';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.RequestModal.EpisodePicker', {
  loadfailed: 'Episode list unavailable.',
  selectall: 'Select all',
  selectnone: 'Clear',
});

interface EpisodePickerProps {
  tvId: number;
  seasonNumber: number;
  seasonSelected: boolean;
  /** Partial selection; undefined means all if the season is on, else none. */
  selected?: number[];
  /** Receives the full wanted set and the season's episode count. */
  onChange: (episodeNumbers: number[], totalEpisodes: number) => void;
}

const EpisodePicker = ({
  tvId,
  seasonNumber,
  seasonSelected,
  selected,
  onChange,
}: EpisodePickerProps) => {
  const intl = useIntl();
  const { data, error } = useSWR<SeasonWithEpisodes>(
    `/api/v1/tv/${tvId}/season/${seasonNumber}`
  );

  if (!data && !error) {
    return (
      <div className="py-3">
        <LoadingSpinner />
      </div>
    );
  }

  if (!data?.episodes?.length) {
    return (
      <p className="px-4 py-3 text-sm text-gray-400">
        {intl.formatMessage(messages.loadfailed)}
      </p>
    );
  }

  const allNumbers = data.episodes.map((episode) => episode.episodeNumber);

  // On with no partial list is every episode; off is none.
  const checked: number[] = seasonSelected
    ? selected && selected.length > 0
      ? selected
      : allNumbers
    : [];

  const toggle = (episodeNumber: number) => {
    const next = checked.includes(episodeNumber)
      ? checked.filter((number) => number !== episodeNumber)
      : [...checked, episodeNumber].sort((a, b) => a - b);

    onChange(next, allNumbers.length);
  };

  return (
    <div className="space-y-1 px-4 py-3">
      <div className="mb-2 flex space-x-3 text-xs">
        <button
          className="text-indigo-400 hover:text-indigo-300 light:text-accent-text light:hover:text-accent-text"
          onClick={() => onChange(allNumbers, allNumbers.length)}
          type="button"
        >
          {intl.formatMessage(messages.selectall)}
        </button>
        <button
          className="text-gray-400 hover:text-gray-300"
          onClick={() => onChange([], allNumbers.length)}
          type="button"
        >
          {intl.formatMessage(messages.selectnone)}
        </button>
      </div>
      {data.episodes.map((episode) => (
        <label
          className="flex items-center space-x-3 py-1 text-sm text-gray-200"
          key={`episode-${seasonNumber}-${episode.episodeNumber}`}
        >
          <input
            checked={checked.includes(episode.episodeNumber)}
            className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-indigo-600"
            onChange={() => toggle(episode.episodeNumber)}
            type="checkbox"
          />
          <span className="min-w-0 flex-1 break-words">
            {episode.episodeNumber}. {episode.name}
          </span>
          {episode.available && (
            <span className="inline-flex">
              <StatusBadgeMini status={MediaStatus.AVAILABLE} />
            </span>
          )}
        </label>
      ))}
    </div>
  );
};

export default EpisodePicker;
