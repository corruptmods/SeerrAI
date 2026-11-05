/*
 * Seasonal themes: for a few days a year Seerr AI dresses up for a season
 * (Halloween, December holidays, New Year, and Lunar New Year if an admin
 * enables it) over each user's own look, reverting by itself when the dates
 * pass.
 *
 * Admins choose which seasons run and when (Settings → Appearance); each user
 * can turn them off (Profile → Settings → Appearance) or turn one season off
 * when its note first shows. Days follow each user's own calendar: a season
 * starts at their local midnight.
 *
 * No server or database access, so pages use it too.
 */

/*
 * Diwali and Pride Month were once seasons. Their saved data is cleared at
 * startup (settings migration 0013 and the ClearRetiredSeasonNotes database
 * migration); anything else naming them reads as an unknown season.
 */
export const SEASON_IDS = [
  'halloween',
  'holidays',
  'newyear',
  'lunarnewyear',
] as const;
export type SeasonId = (typeof SEASON_IDS)[number];

/**
 * One season as an admin set it. Days of the year are 'MM-DD'. A moving
 * season (Lunar New Year) may omit them to have them computed each year.
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

/** A season whose day moves each year, and the days around it. */
interface MovingSeason {
  /** The day itself, 'MM-DD', by year. */
  days: Record<number, string>;
  /** Days the season starts before it and ends after it. */
  before: number;
  after: number;
  /** Source of the dates. */
  source: string;
}

export const MOVING_SEASONS: Record<'lunarnewyear', MovingSeason> = {
  // First day of the first lunar month as China (and Hong Kong) observe it.
  // Countries a time zone away can differ by a day some years (Vietnam's Tết
  // in 2030 is 2 February). Runs from New Year's Eve to the Lantern Festival,
  // the fifteenth day.
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

/** Sent to pages: the enabled seasons in order, with admin-set days if any. */
export interface SeasonCalendarEntry {
  id: SeasonId;
  start?: string;
  end?: string;
}
export type SeasonCalendar = SeasonCalendarEntry[];

/** One run of a season: first and last days, 'YYYY-MM-DD'. */
export interface SeasonDates {
  start: string;
  end: string;
}

/** Today's season. `key` identifies this run, for its note. */
export interface ActiveSeason extends SeasonDates {
  id: SeasonId;
  key: string;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A valid day of the year (29 February counts, as in a leap year). */
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
    // Only a computed-date season may omit its dates.
    return isMovingSeason(id) ? { enabled: value.enabled } : undefined;
  }
  return isDayOfYear(value.start) && isDayOfYear(value.end)
    ? { enabled: value.enabled, start: value.start, end: value.end }
    : undefined;
};

/**
 * Cleans an admin's update: any seasons, each enabled or not with its days;
 * the rest keep their current values (or defaults). Undefined if anything is
 * unknown or not a day.
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
 * Seasons from settings.json, which may be hand-edited: each valid entry is
 * used, anything else falls back to its default.
 */
export const seasonSettings = (stored: unknown): SeasonsSettings =>
  Object.fromEntries(
    SEASON_IDS.map((id) => [
      id,
      (isRecord(stored) && cleanSeason(id, stored[id])) || SEASON_DEFAULTS[id],
    ])
  ) as SeasonsSettings;

/** The enabled seasons, for pages. */
export const seasonCalendar = (seasons: SeasonsSettings): SeasonCalendar =>
  SEASON_IDS.filter((id) => seasons[id].enabled).map((id) => {
    const { start, end } = seasons[id];
    return start && end ? { id, start, end } : { id };
  });

/** 'YYYY-MM-DD' for a whole-day date (as UTC, which has no gaps). */
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const addDays = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
};

/**
 * A day of the year in a given year. 29 February in a non-leap year becomes
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
 * The run of a season starting in the given year; undefined if none (a moving
 * season past its table).
 */
export const seasonDates = (
  season: SeasonCalendarEntry,
  year: number
): SeasonDates | undefined => {
  if (season.start && season.end) {
    // An end earlier in the year than the start falls in the next year.
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

/** Runs of a season that could include a day in the given year. */
const timesAround = (season: SeasonCalendarEntry, year: number) =>
  [year - 1, year, year + 1].flatMap((startYear) => {
    const dates = seasonDates(season, startYear);
    return dates ? [{ ...dates, startYear }] : [];
  });

/**
 * The season on a day ('YYYY-MM-DD'). When two overlap, the most recently
 * started wins (New Year at the end of a long Holidays); on the same day, the
 * first in order.
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
 * The current run of a season on a day, or its next: shown on the Appearance
 * pages.
 */
export const upcomingDates = (
  season: SeasonCalendarEntry,
  today: string
): SeasonDates | undefined =>
  timesAround(season, Number(today.slice(0, 4)))
    .map(({ start, end }) => ({ start, end }))
    .find((dates) => today <= dates.end);

/**
 * Today as 'YYYY-MM-DD' in a time zone: the device's in a browser, the
 * server's on the server. An unknown time zone falls back to the clock's.
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
 * A season's note asks the user, the first time they see it, to keep it or
 * turn it off. The answer is stored on their account as
 * '<season>-<start year>:keep|off', so it applies on every device and is
 * asked again the next time the season comes round.
 */
export type SeasonChoice = 'keep' | 'off';

const NOTE_PATTERN = new RegExp(
  `^(${SEASON_IDS.join('|')})-\\d{4}:(keep|off)$`
);

export const cleanSeasonNote = (value: unknown): string | undefined =>
  typeof value === 'string' && NOTE_PATTERN.test(value) ? value : undefined;

export const seasonNoteValue = (key: string, choice: SeasonChoice): string =>
  `${key}:${choice}`;

/** The user's answer for this run of the season, if any. */
export const noteChoice = (
  season: ActiveSeason,
  note: string | null | undefined
): SeasonChoice | undefined => {
  const [key, choice] = cleanSeasonNote(note)?.split(':') ?? [];
  return key === season.key ? (choice as SeasonChoice) : undefined;
};

/**
 * The season a user sees: today's, unless they turned seasonal themes off or
 * turned this one off from its note.
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
