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
 * What to ask the server for. The season is worked out here, from the
 * person's own calendar, so the page always lists the season it names.
 * Next season is what premieres then: nothing of it has aired yet.
 */
export const animeQuery = (
  choice: AnimeChoice,
  today = new Date()
): { show: 'airing' | 'premieres' | 'popular' | 'films'; season?: string } => {
  const season = choiceSeason(choice, today);
  if (!season) {
    return { show: choice === 'films' ? 'films' : 'popular' };
  }
  return {
    show: choice === 'next' ? 'premieres' : 'airing',
    season: seasonKey(season),
  };
};
