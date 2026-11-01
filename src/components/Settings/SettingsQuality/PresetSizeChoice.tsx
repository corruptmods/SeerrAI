import defineMessages from '@app/utils/defineMessages';
import { episodeCapMbMin, filmCapGb } from '@server/lib/quality/presets';
import type {
  ArrKind,
  FileSize,
  PresetKey,
  PresetSize,
} from '@server/lib/quality/types';
import { MAX_OWN_SIZE } from '@server/lib/quality/types';
import { useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.Settings.SettingsQuality.PresetSizeChoice',
  {
    fileSize: 'File size',
    small: 'Smaller files, up to {limit}',
    balanced: 'Balanced, up to {limit}',
    best: 'Best quality, no limit',
    own: 'Your own limit',
    mbMinute: '{mb} MB a minute',
    gbFilm: '{gb} GB a film',
    unitMbMinute: 'MB a minute',
    unitGbFilm: 'GB a film',
    filmOver: 'A bigger film is never taken.',
  }
);

interface PresetSizeChoiceProps {
  kind: ArrKind;
  preset: PresetKey;
  /** The preset's own size, if it has one. */
  value: PresetSize | undefined;
  /** The server's size, which a preset without its own takes. */
  fallback: FileSize;
  onChange: (size: PresetSize) => void;
}

/**
 * A preset's file size: Smaller files, Balanced or Best quality, each with
 * the limit it sets, or an admin's own, in MB a minute (Sonarr) or GB a
 * film (Radarr).
 */
const PresetSizeChoice = ({
  kind,
  preset,
  value,
  fallback,
  onChange,
}: PresetSizeChoiceProps) => {
  const intl = useIntl();
  const id = useId();
  const size = value ?? fallback;
  const capOf = (s: PresetSize) =>
    kind === 'radarr' ? filmCapGb(s, preset) : episodeCapMbMin(s, preset);
  const limit = (n: number | undefined) =>
    kind === 'radarr'
      ? intl.formatMessage(messages.gbFilm, { gb: n })
      : intl.formatMessage(messages.mbMinute, { mb: n });

  // What is typed, kept while it isn't a whole number in range yet.
  const [typed, setTyped] = useState(
    typeof size === 'number' ? String(size) : ''
  );
  useEffect(() => {
    if (typeof size === 'number') setTyped(String(size));
  }, [size]);

  const choose = (choice: string) => {
    if (choice === 'own') {
      // It starts at the limit chosen so far, or Balanced's after Best.
      onChange(capOf(size) ?? capOf('balanced') ?? 1);
    } else {
      onChange(choice as FileSize);
    }
  };

  const type = (text: string) => {
    setTyped(text);
    const n = Number(text);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_OWN_SIZE) onChange(n);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <label
        htmlFor={`${id}-size`}
        className="!mb-0 basis-full text-xs text-gray-400 sm:basis-auto"
      >
        {intl.formatMessage(messages.fileSize)}
      </label>
      <select
        id={`${id}-size`}
        className="min-w-0 flex-1 !py-1 text-sm sm:!w-80 sm:flex-none"
        value={typeof size === 'number' ? 'own' : size}
        onChange={(e) => choose(e.target.value)}
      >
        <option value="small">
          {intl.formatMessage(messages.small, {
            limit: limit(capOf('small')),
          })}
        </option>
        <option value="balanced">
          {intl.formatMessage(messages.balanced, {
            limit: limit(capOf('balanced')),
          })}
        </option>
        <option value="best">{intl.formatMessage(messages.best)}</option>
        <option value="own">{intl.formatMessage(messages.own)}</option>
      </select>
      {typeof size === 'number' && (
        <span className="flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_OWN_SIZE}
            step={1}
            aria-label={intl.formatMessage(
              kind === 'radarr' ? messages.unitGbFilm : messages.unitMbMinute
            )}
            className="!w-24 !py-1 text-sm"
            value={typed}
            onChange={(e) => type(e.target.value)}
            onBlur={() => setTyped(String(size))}
          />
          <span className="text-xs text-gray-400">
            {intl.formatMessage(
              kind === 'radarr' ? messages.unitGbFilm : messages.unitMbMinute
            )}
          </span>
        </span>
      )}
      {kind === 'radarr' && size !== 'best' && (
        <span className="basis-full text-xs text-gray-400">
          {intl.formatMessage(messages.filmOver)}
        </span>
      )}
    </div>
  );
};

export default PresetSizeChoice;
