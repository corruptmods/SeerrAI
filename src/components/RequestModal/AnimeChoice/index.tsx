import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { SparklesIcon } from '@heroicons/react/24/outline';
import type { SeriesType } from '@server/constants/seriesType';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestModal.AnimeChoice', {
  title: 'Anime',
  label: 'Request as anime',
  hint: 'Ticked when it looks like anime. Anime goes to the anime library.',
});

/**
 * Whether a request goes as anime: the requester's tick, else as
 * lib/animeDecision decides (edited request's type, title setting, matching
 * rule, detection). Never while anime is off, and nothing is sent.
 */
export const useAnimeChoice = ({
  detected,
  animeSetting,
  requestSeriesType,
}: {
  /** Anime detection's verdict. */
  detected: boolean;
  /** The title's anime setting. */
  animeSetting?: boolean | null;
  /** Series type of the request being edited. */
  requestSeriesType?: SeriesType | null;
}) => {
  const { currentSettings } = useSettings();
  const enabled = currentSettings.animeEnabled;
  const [ticked, setChoice] = useState<boolean | null>(null);
  const [ruleSeriesType, setRuleSeriesType] = useState<SeriesType | null>(null);
  const choice = enabled ? ticked : null;
  const automatic =
    enabled &&
    (requestSeriesType
      ? requestSeriesType === 'anime'
      : (animeSetting ??
        (ruleSeriesType ? ruleSeriesType === 'anime' : detected)));

  return {
    anime: choice ?? automatic,
    /** The requester's tick; null while untouched. */
    choice,
    setAnime: (value: boolean) => setChoice(value === automatic ? null : value),
    setRuleSeriesType,
    /** Sent only when the requester changed it. */
    seriesType: (choice === null
      ? undefined
      : choice
        ? 'anime'
        : 'standard') as SeriesType | undefined,
  };
};

interface AnimeChoiceProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** Anime tick in the request dialog, shown to everyone while anime is on. */
const AnimeChoice = ({ checked, onChange }: AnimeChoiceProps) => {
  const intl = useIntl();
  const { currentSettings } = useSettings();

  if (!currentSettings.animeEnabled) {
    return null;
  }

  return (
    <div className="mt-4 border-t border-gray-700 pt-4">
      <div className="mb-2 flex items-center space-x-2 text-sm font-semibold text-gray-300">
        <SparklesIcon className="h-4 w-4" />
        <span>{intl.formatMessage(messages.title)}</span>
      </div>
      <label className="flex items-start space-x-2 text-sm text-gray-200">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 flex-none rounded border-gray-600 bg-gray-700 text-indigo-600"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          {intl.formatMessage(messages.label)}
          <span className="block text-xs text-gray-400">
            {intl.formatMessage(messages.hint)}
          </span>
        </span>
      </label>
    </div>
  );
};

export default AnimeChoice;
