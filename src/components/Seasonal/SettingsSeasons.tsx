import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import {
  formatDates,
  formatDay,
  seasonName,
} from '@app/components/Seasonal/messages';
import { useTheme } from '@app/context/ThemeContext';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { SEASON_LOOKS } from '@app/utils/theme/seasons';
import {
  ArrowDownOnSquareIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';
import type { SeasonId, SeasonsSettings } from '@server/lib/seasons';
import {
  SEASON_DEFAULTS,
  SEASON_IDS,
  isMovingSeason,
  upcomingDates,
} from '@server/lib/seasons';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { useSWRConfig } from 'swr';

const messages = defineMessages('components.Seasonal.SettingsSeasons', {
  seasons: 'Seasonal themes',
  description:
    'Choose which seasons run on this server and when. They sit on top of everyone’s own look and end by themselves. Anyone can still turn them off for themselves.',
  onByDefault: 'On by default',
  offByDefault: 'Off by default',
  movingDates: 'Dates worked out each year',
  showingNow: 'On now, until {date}',
  next: 'Next: {dates}',
  noDates:
    'Its dates aren’t known beyond the coming years. Set them by hand to keep it running.',
  from: 'From',
  to: 'to',
  starts: '{season} starts',
  ends: '{season} ends',
  day: 'Day',
  month: 'Month',
  setDates: 'Set the Dates',
  workOut: 'Work Them Out Each Year',
  saved: 'Seasonal themes saved.',
  failed: 'Something went wrong while saving.',
  loadFailed: 'The seasonal themes could not be loaded.',
});

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A day of the year, 'MM-DD', as a day and a month to pick from. */
const DayPicker = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) => {
  const intl = useIntl();
  const month = Number(value.slice(0, 2));
  const day = Number(value.slice(3));
  const set = (newMonth: number, newDay: number) =>
    onChange(
      `${String(newMonth).padStart(2, '0')}-${String(
        // A day the month doesn't have becomes its last.
        Math.min(newDay, DAYS_IN_MONTH[newMonth - 1])
      ).padStart(2, '0')}`
    );
  return (
    <fieldset className="flex items-center gap-1.5">
      <legend className="sr-only">{label}</legend>
      <select
        aria-label={`${label}: ${intl.formatMessage(messages.day)}`}
        value={day}
        onChange={(e) => set(month, Number(e.target.value))}
        className="!w-auto !py-1.5 !pl-2.5 text-sm"
      >
        {Array.from({ length: DAYS_IN_MONTH[month - 1] }, (_, i) => (
          <option key={i + 1} value={i + 1}>
            {i + 1}
          </option>
        ))}
      </select>
      <select
        aria-label={`${label}: ${intl.formatMessage(messages.month)}`}
        value={month}
        onChange={(e) => set(Number(e.target.value), day)}
        className="!w-auto min-w-[5.5rem] !py-1.5 !pl-2.5 text-sm"
      >
        {DAYS_IN_MONTH.map((_, i) => (
          <option key={i + 1} value={i + 1}>
            {intl.formatDate(new Date(2000, i, 1), { month: 'short' })}
          </option>
        ))}
      </select>
    </fieldset>
  );
};

/** One season: on or off, and when. */
const SeasonRow = ({
  id,
  setting,
  today,
  showingUntil,
  onChange,
}: {
  id: SeasonId;
  setting: SeasonsSettings[SeasonId];
  today: string;
  showingUntil?: string;
  onChange: (setting: SeasonsSettings[SeasonId]) => void;
}) => {
  const intl = useIntl();
  const name = seasonName(intl, id);
  const moving = isMovingSeason(id);
  const byHand = !!(setting.start && setting.end);
  const dates = upcomingDates({ id, ...setting }, today);

  const note = showingUntil
    ? intl.formatMessage(messages.showingNow, {
        date: formatDay(intl, showingUntil),
      })
    : dates
      ? intl.formatMessage(messages.next, { dates: formatDates(intl, dates) })
      : intl.formatMessage(messages.noDates);

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-t border-subtle bg-surface px-4 py-3.5 first:border-t-0">
      <span
        aria-hidden="true"
        className="h-3.5 w-3.5 flex-none rounded-full"
        style={{ backgroundColor: SEASON_LOOKS[id].accent.fill }}
      />
      <div className="min-w-0 flex-1 sm:flex-[1_1_10rem]">
        <div className="font-semibold text-strong">{name}</div>
        <div className="text-xs text-muted">
          {moving && !byHand
            ? intl.formatMessage(messages.movingDates)
            : intl.formatMessage(
                SEASON_DEFAULTS[id].enabled
                  ? messages.onByDefault
                  : messages.offByDefault
              )}
          {' · '}
          {note}
        </div>
      </div>
      {/* Under the name on a phone, so the switch stays beside it. */}
      {byHand ? (
        <div className="order-last flex w-full flex-wrap items-center gap-x-3 gap-y-2 pl-[1.875rem] text-sm text-default sm:order-none sm:w-auto sm:pl-0">
          <span className="flex items-center gap-2">
            <span aria-hidden="true">{intl.formatMessage(messages.from)}</span>
            <DayPicker
              label={intl.formatMessage(messages.starts, { season: name })}
              value={setting.start as string}
              onChange={(start) => onChange({ ...setting, start })}
            />
          </span>
          <span className="flex items-center gap-2">
            <span aria-hidden="true">{intl.formatMessage(messages.to)}</span>
            <DayPicker
              label={intl.formatMessage(messages.ends, { season: name })}
              value={setting.end as string}
              onChange={(end) => onChange({ ...setting, end })}
            />
          </span>
          {moving && (
            <Button
              type="button"
              buttonSize="sm"
              buttonType="ghost"
              onClick={() => onChange({ enabled: setting.enabled })}
            >
              {intl.formatMessage(messages.workOut)}
            </Button>
          )}
        </div>
      ) : (
        <div className="order-last w-full pl-[1.875rem] sm:order-none sm:w-auto sm:pl-0">
          <Button
            type="button"
            buttonSize="sm"
            buttonType="ghost"
            onClick={() => {
              // Start from the days it runs next, where they are known.
              onChange({
                enabled: setting.enabled,
                start: dates?.start.slice(5) ?? '01-01',
                end: dates?.end.slice(5) ?? '01-07',
              });
            }}
          >
            {intl.formatMessage(messages.setDates)}
          </Button>
        </div>
      )}
      <SlideCheckbox
        checked={setting.enabled}
        onClick={() => onChange({ ...setting, enabled: !setting.enabled })}
        label={name}
      />
    </li>
  );
};

/**
 * Settings → Appearance → Seasonal themes: which seasons this server runs,
 * and when. Lunar New Year and Diwali move from year to year; their days
 * come from a table (server/lib/seasons) unless set by hand.
 */
const SettingsSeasons = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { mutate: globalMutate } = useSWRConfig();
  const { today, current } = useTheme();
  const { data, error, mutate } = useSWR<{ seasons: SeasonsSettings }>(
    '/api/v1/settings/appearance/seasons'
  );
  const [seasons, setSeasons] = useState<SeasonsSettings>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setSeasons(data.seasons);
    }
  }, [data]);

  const save = async () => {
    if (!seasons) {
      return;
    }
    setSaving(true);
    try {
      const response = await axios.post<{ seasons: SeasonsSettings }>(
        '/api/v1/settings/appearance/seasons',
        { seasons }
      );
      await mutate(response.data, { revalidate: false });
      // Every page reads the seasons from the public settings.
      await globalMutate('/api/v1/settings/public');
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.failed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-labelledby="settings-seasons"
      className="mt-10 flex flex-col gap-3"
    >
      <h4 id="settings-seasons" className="text-lg font-semibold text-strong">
        {intl.formatMessage(messages.seasons)}
      </h4>
      <p className="text-sm text-muted">
        {intl.formatMessage(messages.description)}
      </p>
      {!seasons && !error ? (
        <LoadingSpinner />
      ) : !seasons ? (
        <Alert type="error" title={intl.formatMessage(messages.loadFailed)}>
          <Button buttonSize="sm" onClick={() => mutate()}>
            <ArrowPathIcon />
            <span>{intl.formatMessage(globalMessages.retry)}</span>
          </Button>
        </Alert>
      ) : (
        <>
          <ul className="overflow-hidden rounded-xl border border-subtle">
            {SEASON_IDS.map((id) => (
              <SeasonRow
                key={id}
                id={id}
                setting={seasons[id]}
                today={today}
                showingUntil={current?.id === id ? current.end : undefined}
                onChange={(setting) =>
                  setSeasons({ ...seasons, [id]: setting })
                }
              />
            ))}
          </ul>
          <div className="actions">
            <div className="flex justify-end">
              <Button
                buttonType="primary"
                type="button"
                disabled={saving}
                onClick={save}
              >
                <ArrowDownOnSquareIcon />
                <span>
                  {saving
                    ? intl.formatMessage(globalMessages.saving)
                    : intl.formatMessage(globalMessages.save)}
                </span>
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
};

export default SettingsSeasons;
