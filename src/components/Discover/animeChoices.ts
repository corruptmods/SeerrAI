import type { AnimeSeason } from '@server/utils/animeSeason';
import { seasonKey, seasonOf, shiftSeason } from '@server/utils/animeSeason';

/** What the Anime page can show, as kept in its address (`?show=`). */
export const ANIME_CHOICES = [
  'this',
  'next',
  'last',
  'popular',
  'films',
] as const;

export type AnimeChoice = (typeof ANIME_CHOICES)[number];

/**
 * The countries the Anime page offers first, where most anime comes from.
 * Any other country can be chosen too.
 */
export const ANIME_COUNTRIES = ['JP', 'KR', 'CN', 'US'] as const;

/** The choice in the address, or this season for anything else. */
export const readAnimeChoice = (value: unknown): AnimeChoice =>
  ANIME_CHOICES.includes(value as AnimeChoice)
    ? (value as AnimeChoice)
    : 'this';

/** The season a choice is for, or null for one that is not seasonal. */
export const choiceSeason = (
  choice: AnimeChoice,
  today = new Date()
): AnimeSeason | null => {
  const now = seasonOf(today);
  switch (choice) {
    case 'this':
      return now;
    case 'next':
      return shiftSeason(now, 1);
    case 'last':
      return shiftSeason(now, -1);
    default:
      return null;
  }
};

/**
 * The country in the address (`?country=`), or undefined for every country
 * (and for anything that is not a country code).
 */
export const readAnimeCountry = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-z]{2}$/i.test(value)
    ? value.toUpperCase()
    : undefined;

/**
 * What to ask the server for. The season is worked out here, from the
 * person's own calendar, so the page always lists the season it names.
 * Next season is what premieres then: nothing of it has aired yet.
 */
export const animeQuery = (
  choice: AnimeChoice,
  today = new Date(),
  country?: string
): {
  show: 'airing' | 'premieres' | 'popular' | 'films';
  season?: string;
  country?: string;
} => {
  const season = choiceSeason(choice, today);
  const where = country ? { country } : {};
  if (!season) {
    return { show: choice === 'films' ? 'films' : 'popular', ...where };
  }
  return {
    show: choice === 'next' ? 'premieres' : 'airing',
    season: seasonKey(season),
    ...where,
  };
};
