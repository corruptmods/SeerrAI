// Anime seasons, as fans count them: calendar quarters Winter (January to
// March), Spring, Summer and Fall. The server uses them to query TMDB for a
// season's series, the pages to name it ("Fall 2026").

export const ANIME_SEASON_NAMES = [
  'winter',
  'spring',
  'summer',
  'fall',
] as const;

export type AnimeSeasonName = (typeof ANIME_SEASON_NAMES)[number];

export interface AnimeSeason {
  year: number;
  name: AnimeSeasonName;
}

/** The season containing a date, by the local calendar. */
export const seasonOf = (date: Date): AnimeSeason => ({
  year: date.getFullYear(),
  name: ANIME_SEASON_NAMES[Math.floor(date.getMonth() / 3)],
});

/** The season `by` seasons after this one (before, if negative). */
export const shiftSeason = (season: AnimeSeason, by: number): AnimeSeason => {
  const index = season.year * 4 + ANIME_SEASON_NAMES.indexOf(season.name) + by;
  return {
    year: Math.floor(index / 4),
    name: ANIME_SEASON_NAMES[((index % 4) + 4) % 4],
  };
};

const pad = (value: number) => String(value).padStart(2, '0');

/** A season's first and last day, in TMDB's date format (YYYY-MM-DD). */
export const seasonDates = (
  season: AnimeSeason
): { start: string; end: string } => {
  const firstMonth = ANIME_SEASON_NAMES.indexOf(season.name) * 3;
  // Day 0 of the month after the season is its last day.
  const lastDay = new Date(season.year, firstMonth + 3, 0).getDate();
  return {
    start: `${season.year}-${pad(firstMonth + 1)}-01`,
    end: `${season.year}-${pad(firstMonth + 3)}-${pad(lastDay)}`,
  };
};

/** A season's URL form: "2026-fall". */
export const seasonKey = (season: AnimeSeason): string =>
  `${season.year}-${season.name}`;

/** Parses a season's URL form, or null if invalid. */
export const parseSeasonKey = (key?: string | null): AnimeSeason | null => {
  const match = /^(\d{4})-(winter|spring|summer|fall)$/.exec(key ?? '');
  if (!match || Number(match[1]) < 1900) {
    return null;
  }
  return { year: Number(match[1]), name: match[2] as AnimeSeasonName };
};
