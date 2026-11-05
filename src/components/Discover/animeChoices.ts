import type { AnimeSeason } from '@server/utils/animeSeason';
import { seasonKey, seasonOf, shiftSeason } from '@server/utils/animeSeason';

/** Anime page views, as in `?show=`. */
export const ANIME_CHOICES = [
  'this',
  'next',
  'last',
  'popular',
  'films',
] as const;

export type AnimeChoice = (typeof ANIME_CHOICES)[number];

/** Countries offered first on the Anime page; any other can be chosen too. */
export const ANIME_COUNTRIES = ['JP', 'KR', 'CN', 'US'] as const;

/** The URL's choice, or `this` for anything invalid. */
export const readAnimeChoice = (value: unknown): AnimeChoice =>
  ANIME_CHOICES.includes(value as AnimeChoice)
    ? (value as AnimeChoice)
    : 'this';

/** The season a choice is for; null when not seasonal. */
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

/** The `?country=` code; undefined for all countries or an invalid code. */
export const readAnimeCountry = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-z]{2}$/i.test(value)
    ? value.toUpperCase()
    : undefined;

/**
 * The server query. The season comes from the client's calendar so the list
 * matches the season the page names. Next season means premieres.
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
