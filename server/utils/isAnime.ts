import {
  ANIMATION_GENRE_ID,
  ANIME_KEYWORD_ID,
} from '@server/api/themoviedb/constants';

type Keyword = { id: number };
type Country = { iso_3166_1: string };

/**
 * What anime is told by, in any shape a title arrives in: TMDB's own
 * (keywords under `results`, or `keywords` for a movie, `original_language`
 * and `origin_country` or `production_countries`) or the app's (a keyword
 * list, `originalLanguage`, and `originCountry` or `productionCountries`).
 */
export interface AnimeSignals {
  keywords?: Keyword[] | { results?: Keyword[]; keywords?: Keyword[] };
  genres?: { id: number }[];
  original_language?: string;
  originalLanguage?: string;
  origin_country?: string[];
  originCountry?: string[];
  production_countries?: Country[];
  productionCountries?: Country[];
}

/** Where a title was made: its origin countries, or else where it was produced. */
const countriesOf = (media: AnimeSignals): string[] =>
  media.origin_country?.length
    ? media.origin_country
    : media.originCountry?.length
      ? media.originCountry
      : (media.production_countries ?? media.productionCountries ?? []).map(
          (country) => country.iso_3166_1
        );

/**
 * Whether a title should not count as anime because of where it was made:
 * it is not in Japanese, and one of the countries it comes from is on the
 * admin's list (Settings → Services → Anime, "Leave out anime made in").
 * Anime-styled western shows such as Avatar or Castlevania carry TMDB's
 * anime keyword; an admin who keeps them with the rest of the library lists
 * the United States. Anything made in Japanese still counts.
 */
export const leftOutAsAnime = (
  media: AnimeSignals,
  leaveOut: readonly string[]
): boolean => {
  if (!leaveOut.length) {
    return false;
  }
  const language = media.original_language ?? media.originalLanguage;
  return (
    language !== 'ja' &&
    countriesOf(media).some((country) => leaveOut.includes(country))
  );
};

/**
 * Whether a title is anime: the one test Seerr uses everywhere, so where
 * a request is sent, the metadata a scan reads, and what the pages say all
 * agree. `leaveOut` is the admin's list of countries whose anime does not
 * count (see leftOutAsAnime); the server passes its setting, the pages the
 * same setting from the public settings. An override rule, or the Anime
 * switch on a request, can still send a left-out title as anime.
 *
 * TMDB's "anime" keyword (210024) is the strongest signal, from any
 * country, but it is missing from plenty of anime, which then went to
 * Sonarr as standard series (seerr-team/seerr#3244). Failing it, animation
 * whose original language is Japanese counts. Animation in other languages
 * without the keyword (Korean or Chinese animation, western cartoons) does
 * not; an override rule can route those as anime where wanted.
 */
export const isAnime = (
  media: AnimeSignals,
  leaveOut: readonly string[]
): boolean => {
  if (leftOutAsAnime(media, leaveOut)) {
    return false;
  }

  const keywords = Array.isArray(media.keywords)
    ? media.keywords
    : (media.keywords?.results ?? media.keywords?.keywords ?? []);

  if (keywords.some((keyword) => keyword.id === ANIME_KEYWORD_ID)) {
    return true;
  }

  return (
    !!media.genres?.some((genre) => genre.id === ANIMATION_GENRE_ID) &&
    (media.original_language ?? media.originalLanguage) === 'ja'
  );
};

export default isAnime;
