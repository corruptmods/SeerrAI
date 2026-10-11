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
 * Whether a title is anime: the one test Seerr uses everywhere, so where
 * a request is sent, the metadata a scan reads, and what the pages say all
 * agree.
 *
 * American titles that are not in Japanese never count: anime-styled
 * western shows such as Avatar or Castlevania carry TMDB's anime keyword
 * but belong with the rest of the library. An override rule, or the Anime
 * switch on a request, can still send one as anime.
 *
 * Otherwise TMDB's "anime" keyword (210024) is the strongest signal, but it
 * is missing from plenty of anime, which then went to Sonarr as standard
 * series (seerr-team/seerr#3244). Failing it, animation whose original
 * language is Japanese counts. Animation in other languages (Korean or
 * Chinese animation, western cartoons) does not; an override rule can
 * route those as anime where wanted.
 */
export const isAnime = (media: AnimeSignals): boolean => {
  const language = media.original_language ?? media.originalLanguage;

  if (language !== 'ja' && countriesOf(media).includes('US')) {
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
    language === 'ja'
  );
};

export default isAnime;
