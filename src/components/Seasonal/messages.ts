import defineMessages from '@app/utils/defineMessages';
import type { SeasonId } from '@server/lib/seasons';
import type { IntlShape } from 'react-intl';

/** Season names and date formats. */
export const seasonMessages = defineMessages('components.Seasonal', {
  halloween: 'Halloween',
  holidays: 'Holidays',
  newyear: 'New Year',
  lunarnewyear: 'Lunar New Year',
  dates: '{start} to {end}',
});

export const seasonName = (intl: IntlShape, id: SeasonId): string =>
  intl.formatMessage(seasonMessages[id]);

/** Formats 'YYYY-MM-DD' or 'MM-DD' as a localised day ("1 November"), in local time. */
export const formatDay = (intl: IntlShape, day: string): string => {
  const [month, date] = day.slice(-5).split('-').map(Number);
  // A leap year, so 29 February formats.
  const year = day.length > 5 ? Number(day.slice(0, 4)) : 2000;
  return intl.formatDate(new Date(year, month - 1, date), {
    day: 'numeric',
    month: 'long',
  });
};

export const formatDates = (
  intl: IntlShape,
  dates: { start: string; end: string }
): string =>
  intl.formatMessage(seasonMessages.dates, {
    start: formatDay(intl, dates.start),
    end: formatDay(intl, dates.end),
  });
