/*
 * TMDB genres by name, to check that AI Search's titles are of the genre
 * asked for. Films and series have different lists: series have no Horror
 * or Thriller, and pair some genres ("Sci-Fi & Fantasy", "Action &
 * Adventure"), so each name is looked up per media type.
 */

const MOVIE_GENRES: Record<string, number[]> = {
  action: [28],
  adventure: [12],
  'action and adventure': [28, 12],
  animation: [16],
  animated: [16],
  anime: [16],
  cartoon: [16],
  comedy: [35],
  crime: [80],
  documentary: [99],
  drama: [18],
  family: [10751],
  kids: [10751],
  children: [10751],
  fantasy: [14],
  history: [36],
  historical: [36],
  horror: [27],
  music: [10402],
  musical: [10402],
  mystery: [9648],
  romance: [10749],
  romantic: [10749],
  'science fiction': [878],
  'sci fi': [878],
  scifi: [878],
  'sci fi and fantasy': [878, 14],
  thriller: [53],
  war: [10752],
  'war and politics': [10752],
  western: [37],
  'tv movie': [10770],
};

const TV_GENRES: Record<string, number[]> = {
  action: [10759],
  adventure: [10759],
  'action and adventure': [10759],
  animation: [16],
  animated: [16],
  anime: [16],
  cartoon: [16],
  comedy: [35],
  crime: [80],
  documentary: [99],
  drama: [18],
  family: [10751],
  kids: [10762],
  children: [10762],
  fantasy: [10765],
  mystery: [9648],
  news: [10763],
  reality: [10764],
  'science fiction': [10765],
  'sci fi': [10765],
  scifi: [10765],
  'sci fi and fantasy': [10765],
  soap: [10766],
  talk: [10767],
  war: [10768],
  politics: [10768],
  'war and politics': [10768],
  western: [37],
};

/** "Sci-Fi & Fantasy" and "sci-fi and fantasy" alike. */
const genreKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z]+/g, ' ')
    .trim();

/**
 * The genre ids, for one media type, of any of the genres named; null when
 * any of them doesn't exist for it, so that type is not filtered (a result
 * could fit the one that doesn't).
 */
export const genreIdsFor = (
  names: string[],
  kind: 'movie' | 'tv'
): Set<number> | null => {
  const table = kind === 'movie' ? MOVIE_GENRES : TV_GENRES;
  const each = names.map((name) => table[genreKey(name)]);
  if (!each.length || each.some((ids) => !ids?.length)) return null;
  return new Set(each.flat() as number[]);
};

/**
 * Whether a TMDB result has any of the genres named. A media type without
 * one of them, or a result TMDB gave no genres for, is not judged.
 */
export const fitsGenres = (
  result: { mediaType?: string; genreIds?: number[] },
  names: string[]
): boolean => {
  if (
    !names.length ||
    (result.mediaType !== 'movie' && result.mediaType !== 'tv') ||
    !result.genreIds?.length
  ) {
    return true;
  }
  const wanted = genreIdsFor(names, result.mediaType);
  return !wanted || result.genreIds.some((id) => wanted.has(id));
};
