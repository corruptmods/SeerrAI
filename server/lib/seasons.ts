/*
 * Seasonal themes: for a few days a year Seerr AI dresses up for a season
 * (Halloween, the December holidays, New Year, and Lunar New Year if an
 * admin turns it on), on top of each person's own look, and goes back to it by itself when
 * the dates pass.
 *
 * An admin chooses which seasons run and when (Settings → Appearance); each
 * person can switch them off for themselves (Profile → Settings →
 * Appearance), or turn off one season when its note first shows. The days
 * are counted on each person's own calendar: a season starts at midnight
 * where they are.
 *
 * Nothing here touches the server or the database, so pages use it too.
 */

/*
 * Diwali and Pride Month were seasons once. What was saved for them is
 * cleared when the server starts (settings migration 0013, and the
 * ClearRetiredSeasonNotes database migration), and anything else naming
 * them reads as a season that doesn't exist.
 */
export const SEASON_IDS = [
  'halloween',
  'holidays',
  'newyear',
  'lunarnewyear',
] as const;
export type SeasonId = (typeof SEASON_IDS)[number];

/**
 * One season as an admin set it. Days of the year are 'MM-DD'. A season
 * whose dates move (Lunar New Year) may leave them out, to have them
 * worked out each year.
 */
export interface SeasonSetting {
  enabled: boolean;
  start?: string;
  end?: string;
}

export type SeasonsSettings = Record<SeasonId, SeasonSetting>;

export const SEASON_DEFAULTS: SeasonsSettings = {
  halloween: { enabled: true, start: '10-24', end: '11-01' },
  holidays: { enabled: true, start: '12-01', end: '12-28' },
  newyear: { enabled: true, start: '12-29', end: '01-02' },
  lunarnewyear: { enabled: false },
};

/** A season whose day moves from year to year, and the days around it. */
interface MovingSeason {
  /** The day itself, 'MM-DD', by year. */
  days: Record<number, string>;
  /** How many days the season starts before it and ends after it. */
  before: number;
  after: number;
  /** Where the days come from. */
  source: string;
}

export const MOVING_SEASONS: Record<'lunarnewyear', MovingSeason> = {
  // The first day of the first lunar month, as China (and Hong Kong)
  // keep it. Countries a time zone away can differ by a day in some
  // years (Vietnam's Tết in 2030 is 2 February). The season runs from
  // New Year's Eve to the Lantern Festival, the fifteenth day.
  lunarnewyear: {
    days: {
      2025: '01-29',
      2026: '02-17',
      2027: '02-06',
      2028: '01-26',
      2029: '02-13',
      2030: '02-03',
      2031: '01-23',
      2032: '02-11',
      2033: '01-31',
      2034: '02-19',
      2035: '02-08',
      2036: '01-28',
      2037: '02-15',
      2038: '02-04',
      2039: '01-24',
      2040: '02-12',
    },
    before: 1,
    after: 14,
    source:
      'Hong Kong Observatory Gregorian–Lunar calendar conversion table (2027); ' +
      'timeanddate.com (2025–2030); Wikipedia, Chinese New Year (2026–2037); ' +
      'herongyang.com (2031–2040). Checked October 2026; they agree.',
  },
};

export const isMovingSeason = (
  id: SeasonId
): id is keyof typeof MOVING_SEASONS => id in MOVING_SEASONS;

/**
 * What pages are told: the seasons that run, in order, with their days if
 * an admin set them.
 */
export interface SeasonCalendarEntry {
  id: SeasonId;
  start?: string;
  end?: string;
}
export type SeasonCalendar = SeasonCalendarEntry[];

/** One time a season runs: its first and last days, 'YYYY-MM-DD'. */
export interface SeasonDates {
  start: string;
  end: string;
}

/** The season running today. `key` names this time it runs, for its note. */
export interface ActiveSeason extends SeasonDates {
  id: SeasonId;
  key: string;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A day of the year that exists (in a leap year, for 29 February). */
const isDayOfYear = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const month = Number(value.slice(0, 2));
  const day = Number(value.slice(3));
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]
  );
};

const cleanSeason = (
  id: SeasonId,
  value: unknown
): SeasonSetting | undefined => {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      ['enabled', 'start', 'end'].includes(key)
    ) ||
    typeof value.enabled !== 'boolean'
  ) {
    return undefined;
  }
  if (value.start === undefined && value.end === undefined) {
    // Only a season whose dates are worked out can go without them.
    return isMovingSeason(id) ? { enabled: value.enabled } : undefined;
  }
  return isDayOfYear(value.start) && isDayOfYear(value.end)
    ? { enabled: value.enabled, start: value.start, end: value.end }
    : undefined;
};

/**
 * What an admin sends, as it is kept: any of the seasons, each switched on
 * or off with its days; the rest stay as they were (or their defaults).
 * Undefined if anything in it is unknown or not a day.
 */
export const cleanSeasons = (
  value: unknown,
  base: SeasonsSettings = SEASON_DEFAULTS
): SeasonsSettings | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const seasons: SeasonsSettings = { ...base };
  for (const [id, setting] of Object.entries(value)) {
    if (!(SEASON_IDS as readonly string[]).includes(id)) {
      return undefined;
    }
    const clean = cleanSeason(id as SeasonId, setting);
    if (!clean) {
      return undefined;
    }
    seasons[id as SeasonId] = clean;
  }
  return seasons;
};

/**
 * The seasons as kept in settings.json, which can be edited by hand: each
 * one that reads is used, anything else is its default.
 */
export const seasonSettings = (stored: unknown): SeasonsSettings =>
  Object.fromEntries(
    SEASON_IDS.map((id) => [
      id,
      (isRecord(stored) && cleanSeason(id, stored[id])) || SEASON_DEFAULTS[id],
    ])
  ) as SeasonsSettings;

/** The seasons that run, for pages. */
export const seasonCalendar = (seasons: SeasonsSettings): SeasonCalendar =>
  SEASON_IDS.filter((id) => seasons[id].enabled).map((id) => {
    const { start, end } = seasons[id];
    return start && end ? { id, start, end } : { id };
  });

/** 'YYYY-MM-DD' for a date counted in whole days (as UTC, which has no gaps). */
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const addDays = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
};

/**
 * A day of the year in a given year. 29 February in a year without one is
 * the 28th, so a season ending on it still ends in February.
 */
const inYear = (dayOfYear: string, year: number): string => {
  const day = `${year}-${dayOfYear}`;
  return dayOfYear === '02-29' &&
    !isoDay(new Date(`${day}T00:00:00Z`)).endsWith('02-29')
    ? `${year}-02-28`
    : day;
};

/**
 * The time a season runs that starts in the given year, or undefined if it
 * has none (a moving season beyond its table).
 */
export const seasonDates = (
  season: SeasonCalendarEntry,
  year: number
): SeasonDates | undefined => {
  if (season.start && season.end) {
    // An end earlier in the year than the start is in the next year.
    const crosses = season.end < season.start;
    return {
      start: inYear(season.start, year),
      end: inYear(season.end, crosses ? year + 1 : year),
    };
  }
  if (!isMovingSeason(season.id)) {
    return undefined;
  }
  const moving = MOVING_SEASONS[season.id];
  const day = moving.days[year];
  if (!day) {
    return undefined;
  }
  const date = `${year}-${day}`;
  return {
    start: addDays(date, -moving.before),
    end: addDays(date, moving.after),
  };
};

/** Each time a season runs that could include the given day. */
const timesAround = (season: SeasonCalendarEntry, year: number) =>
  [year - 1, year, year + 1].flatMap((startYear) => {
    const dates = seasonDates(season, startYear);
    return dates ? [{ ...dates, startYear }] : [];
  });

/**
 * The season running on a day ('YYYY-MM-DD'). When two meet, the one that
 * started most recently shows (New Year at the end of a long Holidays); on
 * the same day, the first in order.
 */
export const activeSeason = (
  calendar: SeasonCalendar,
  today: string
): ActiveSeason | undefined => {
  const year = Number(today.slice(0, 4));
  let found: ActiveSeason | undefined;
  const inOrder = [...calendar].sort(
    (a, b) => SEASON_IDS.indexOf(a.id) - SEASON_IDS.indexOf(b.id)
  );
  for (const season of inOrder) {
    for (const time of timesAround(season, year)) {
      if (
        time.start <= today &&
        today <= time.end &&
        (!found || time.start > found.start)
      ) {
        found = {
          id: season.id,
          start: time.start,
          end: time.end,
          key: `${season.id}-${time.startYear}`,
        };
      }
    }
  }
  return found;
};

/**
 * The time a season is running on a day, or the next time it will: what
 * the Appearance pages show beside it.
 */
export const upcomingDates = (
  season: SeasonCalendarEntry,
  today: string
): SeasonDates | undefined =>
  timesAround(season, Number(today.slice(0, 4)))
    .map(({ start, end }) => ({ start, end }))
    .find((dates) => today <= dates.end);

/**
 * Today's date, 'YYYY-MM-DD', on the calendar of a time zone: the device's
 * own in a browser, the server's on the server. An unknown time zone falls
 * back to the clock's own.
 */
export const localDay = (now: Date, timeZone?: string): string => {
  const format = (zone?: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .reduce<Record<string, string>>(
        (parts, part) => ({ ...parts, [part.type]: part.value }),
        {}
      );
  let parts: Record<string, string>;
  try {
    parts = format(timeZone);
  } catch {
    parts = format();
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
};

/*
 * The note a season shows the first time someone sees it asks them to keep
 * it or turn it off. Their answer is kept with their account as
 * '<season>-<year it started>:keep|off', so it holds on every device and
 * is asked again the next time the season comes round.
 */
export type SeasonChoice = 'keep' | 'off';

const NOTE_PATTERN = new RegExp(
  `^(${SEASON_IDS.join('|')})-\\d{4}:(keep|off)$`
);

export const cleanSeasonNote = (value: unknown): string | undefined =>
  typeof value === 'string' && NOTE_PATTERN.test(value) ? value : undefined;

export const seasonNoteValue = (key: string, choice: SeasonChoice): string =>
  `${key}:${choice}`;

/** Their answer for this time the season runs, if they have given one. */
export const noteChoice = (
  season: ActiveSeason,
  note: string | null | undefined
): SeasonChoice | undefined => {
  const [key, choice] = cleanSeasonNote(note)?.split(':') ?? [];
  return key === season.key ? (choice as SeasonChoice) : undefined;
};

/**
 * The season a person sees: the one running today, unless they switched
 * seasonal themes off, or turned this one off when its note showed.
 */
export const shownSeason = ({
  calendar,
  seasonal,
  note,
  today,
}: {
  calendar: SeasonCalendar;
  seasonal: boolean;
  note?: string | null;
  today: string;
}): ActiveSeason | undefined => {
  if (!seasonal) {
    return undefined;
  }
  const season = activeSeason(calendar, today);
  return season && noteChoice(season, note) !== 'off' ? season : undefined;
};
