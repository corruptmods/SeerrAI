import {
  ANIMATION_GENRE_ID,
  ANIME_KEYWORD_ID,
} from '@server/api/themoviedb/constants';

type Keyword = { id: number };
type Country = { iso_3166_1: string };

/**
 * Anime signals in any shape a title arrives in: TMDB's (keywords under
 * `results`, or `keywords` for a movie, `original_language`, and
 * `origin_country` or `production_countries`) or the app's (a keyword list,
 * `originalLanguage`, and `originCountry` or `productionCountries`).
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

/**
 * Where a title was made: its origin countries, else its production countries.
 */
const countriesOf = (media: AnimeSignals): string[] =>
  media.origin_country?.length
    ? media.origin_country
    : media.originCountry?.length
      ? media.originCountry
      : (media.production_countries ?? media.productionCountries ?? []).map(
          (country) => country.iso_3166_1
        );

/**
 * Whether a title is excluded from anime by origin: not in Japanese, and from a
 * country on the admin's list (Settings → Services → Anime, "Leave out anime
 * made in"). Anime-styled western shows such as Windcaller or Gravespire carry
 * TMDB's anime keyword; an admin keeping them with the main library lists the
 * United States. Anything in Japanese still counts.
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
 * Whether a title is anime: the single test Seerr uses everywhere, so request
 * routing, scan metadata and the pages agree. `leaveOut` is the admin's
 * excluded countries (see leftOutAsAnime); the server passes its setting, the
 * pages the same from public settings. An override rule or a request's Anime
 * switch can still send an excluded title as anime. Override rules naming the
 * anime keyword follow this decision (with the title's and request's own choice
 * over it), not the keyword alone.
 *
 * TMDB's "anime" keyword (210024) is the strongest signal, from any country,
 * but much anime lacks it and went to Sonarr as standard series
 * (seerr-team/seerr#3244). Failing it, animation in original-language Japanese
 * counts. Other-language animation without the keyword (Korean or Chinese
 * animation, western cartoons) doesn't; an override rule can route it as anime.
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
