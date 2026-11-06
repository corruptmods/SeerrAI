/**
 * Search scope. All is films, series, collections and people; music is
 * separate unless an admin adds it below (Settings → Music).
 */
export type SearchType = 'all' | 'movie' | 'tv' | 'person' | 'music';

/** The URL's search type, if this user can use it. */
export const searchType = (
  value: string | string[] | undefined,
  musicOn: boolean
): SearchType =>
  value === 'movie' ||
  value === 'tv' ||
  value === 'person' ||
  (value === 'music' && musicOn)
    ? value
    : 'all';

/*
 * Result order. TMDB's search only ranks by relevance, so any other order
 * sorts the results loaded so far, not every match.
 */
export const SEARCH_SORTS = [
  'relevance',
  'newest',
  'oldest',
  'rating',
  'popularity',
] as const;

export type SearchSort = (typeof SEARCH_SORTS)[number];

/** The URL's sort; relevance unless another is asked for. */
export const searchSort = (value: string | string[] | undefined): SearchSort =>
  SEARCH_SORTS.includes(value as SearchSort)
    ? (value as SearchSort)
    : 'relevance';

/** Sorts that mean something for a kind of search: people have no dates or ratings. */
export const searchSortsFor = (type: SearchType): readonly SearchSort[] =>
  type === 'music'
    ? []
    : type === 'person'
      ? ['relevance', 'popularity']
      : SEARCH_SORTS;

/** The sort to use for a kind of search: the one asked for, if it fits. */
export const effectiveSearchSort = (
  sort: SearchSort,
  type: SearchType
): SearchSort => (searchSortsFor(type).includes(sort) ? sort : 'relevance');

/** Pages loaded before sorting another way, so the sort has enough to go on. */
export const SORTED_PAGES = 5;

/** Below this many votes a rating says little, so it sorts after the rest. */
export const MIN_RATING_VOTES = 10;

interface Sortable {
  mediaType: string;
  releaseDate?: string;
  firstAirDate?: string;
  voteAverage?: number;
  voteCount?: number;
  popularity?: number;
}

/** Epoch ms of a film's or series' first date; none for people or collections. */
const dateOf = (item: Sortable) => {
  const text =
    item.mediaType === 'movie'
      ? item.releaseDate
      : item.mediaType === 'tv'
        ? item.firstAirDate
        : undefined;
  const time = text ? Date.parse(text) : NaN;
  return Number.isNaN(time) ? undefined : time;
};

const ratingOf = (item: Sortable) =>
  (item.mediaType === 'movie' || item.mediaType === 'tv') &&
  (item.voteCount ?? 0) >= MIN_RATING_VOTES
    ? (item.voteAverage ?? 0)
    : undefined;

/** Higher first; without a value, after every one with one. */
const highFirst = (a: number | undefined, b: number | undefined) =>
  a === undefined || b === undefined
    ? a === b
      ? 0
      : a === undefined
        ? 1
        : -1
    : b - a;

/**
 * The results in the chosen order; ties, and anything without the value
 * (people have no date, collections no rating), keep TMDB's order after the
 * rest.
 */
export const sortSearchResults = <T extends Sortable>(
  items: T[],
  sort: SearchSort
): T[] => {
  if (sort === 'relevance') {
    return items;
  }
  const value = (item: T): number | undefined => {
    switch (sort) {
      case 'newest':
        return dateOf(item);
      case 'oldest': {
        const time = dateOf(item);
        return time === undefined ? undefined : -time;
      }
      case 'rating':
        return ratingOf(item);
      case 'popularity':
        return item.popularity;
    }
  };
  return items
    .map((item, index) => ({ item, index, value: value(item) }))
    .sort((a, b) => highFirst(a.value, b.value) || a.index - b.index)
    .map(({ item }) => item);
};

/**
 * Whether All includes music below films and series: when an admin enabled
 * it and music isn't off globally or for the user. Off if the server doesn't say.
 */
export const musicInAll = (
  musicOn: boolean,
  chosen: { inAll?: boolean } | undefined
): boolean => musicOn && (chosen?.inAll ?? false);

/**
 * Whether to show music below the titles: All only, and only once titles
 * have loaded, so slow MusicBrainz results never delay or precede them.
 */
export const musicBelowTitles = (
  type: SearchType,
  inAll: boolean,
  titlesLoaded: boolean
): boolean => type === 'all' && inAll && titlesLoaded;
