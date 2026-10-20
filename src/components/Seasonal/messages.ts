import defineMessages from '@app/utils/defineMessages';
import type { SeasonId } from '@server/lib/seasons';
import type { IntlShape } from 'react-intl';

/** Each season's name, and how its days are written. */
export const seasonMessages = defineMessages('components.Seasonal', {
  halloween: 'Halloween',
  holidays: 'Holidays',
  newyear: 'New Year',
  lunarnewyear: 'Lunar New Year',
  dates: '{start} to {end}',
});

export const seasonName = (intl: IntlShape, id: SeasonId): string =>
  intl.formatMessage(seasonMessages[id]);

/**
 * A day, 'YYYY-MM-DD' or 'MM-DD', as people write it ("1 November", or
 * "November 1" where that is the way). Read as a day where the person is.
 */
export const formatDay = (intl: IntlShape, day: string): string => {
  const [month, date] = day.slice(-5).split('-').map(Number);
  // 2000 had a 29 February, so every day of the year can be written.
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
