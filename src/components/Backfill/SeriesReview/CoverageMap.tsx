import { episodeLabel } from '@app/components/Backfill/shared';
import type { CoverageEpisode } from '@app/components/Backfill/types';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Backfill.CoverageMap', {
  season: 'Season {number}',
  onDisk: 'On disk',
  belowCutoff: 'On disk, below cutoff',
  missing: 'Missing',
  later: 'Not aired or not monitored',
  covered: 'In the selected pack',
  cell: '{label}: {state}{quality}',
});

/*
 * Every episode as a square, a row per season: what is on disk, what is
 * below the profile's cutoff, what is missing, and outlined, what the
 * selected pack would fill or upgrade. Colours are whole class names, never
 * built at runtime, so the CSS keeps them.
 */
const STATE_CLASS = {
  onDisk: 'bg-green-600',
  belowCutoff: 'bg-yellow-500',
  missing: 'bg-red-600',
  later: 'bg-gray-600',
} as const;

const stateOf = (ep: CoverageEpisode): keyof typeof STATE_CLASS =>
  ep.state === 'onDisk'
    ? ep.belowCutoff
      ? 'belowCutoff'
      : 'onDisk'
    : ep.state === 'missing'
      ? 'missing'
      : 'later';

const CoverageMap = ({
  episodes,
  covered,
  anime,
}: {
  episodes: CoverageEpisode[];
  covered: Set<number>;
  anime: boolean;
}) => {
  const intl = useIntl();
  const seasons = new Map<number, CoverageEpisode[]>();
  for (const ep of episodes) {
    seasons.set(ep.season, [...(seasons.get(ep.season) ?? []), ep]);
  }
  const range = (eps: CoverageEpisode[]) => {
    const nums = eps
      .map((e) => (anime ? e.absolute : e.episode))
      .filter((n): n is number => typeof n === 'number');
    return nums.length ? `${Math.min(...nums)}–${Math.max(...nums)}` : '';
  };
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-gray-400">
        {(
          [
            ['onDisk', messages.onDisk],
            ['belowCutoff', messages.belowCutoff],
            ['missing', messages.missing],
            ['later', messages.later],
          ] as const
        ).map(([key, label]) => (
          <span key={key} className="inline-flex items-center gap-2">
            <span className={`h-3 w-3 rounded-sm ${STATE_CLASS[key]}`} />
            {intl.formatMessage(label)}
          </span>
        ))}
        <span className="inline-flex items-center gap-2">
          <span className="h-3 w-3 rounded-sm ring-2 ring-indigo-200" />
          {intl.formatMessage(messages.covered)}
        </span>
      </div>
      <div className="space-y-2">
        {[...seasons.entries()].map(([season, eps]) => (
          <div key={season} className="flex items-start gap-3">
            <div className="w-20 flex-shrink-0 pt-px text-xs font-semibold text-gray-400">
              {intl.formatMessage(messages.season, { number: season })}
            </div>
            <div className="flex flex-1 flex-wrap gap-[3px]">
              {eps.map((ep) => {
                const state = stateOf(ep);
                return (
                  <span
                    key={ep.id}
                    title={intl.formatMessage(messages.cell, {
                      label: episodeLabel({
                        absolute: anime ? ep.absolute : undefined,
                        season: ep.season,
                        episode: ep.episode,
                      }),
                      state: intl.formatMessage(
                        state === 'onDisk'
                          ? messages.onDisk
                          : state === 'belowCutoff'
                            ? messages.belowCutoff
                            : state === 'missing'
                              ? messages.missing
                              : messages.later
                      ),
                      quality: ep.quality ? ` (${ep.quality})` : '',
                    })}
                    className={`h-3.5 w-3.5 rounded-sm ${STATE_CLASS[state]} ${
                      covered.has(ep.id) ? 'ring-2 ring-indigo-200' : ''
                    }`}
                  />
                );
              })}
            </div>
            <div className="w-16 flex-shrink-0 whitespace-nowrap text-right text-xs text-gray-500">
              {range(eps)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default CoverageMap;
