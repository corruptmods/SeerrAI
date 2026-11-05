/**
 * Search scope. All is films, series, collections and people; music is
 * separate unless an admin adds it below (Settings → Music).
 */
export type SearchType = 'all' | 'movie' | 'tv' | 'music';

/** The URL's search type, if this user can use it. */
export const searchType = (
  value: string | string[] | undefined,
  musicOn: boolean
): SearchType =>
  value === 'movie' || value === 'tv' || (value === 'music' && musicOn)
    ? value
    : 'all';

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
