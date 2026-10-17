/**
 * What a search shows. Everything is films, series, collections and
 * people; music is on its own, unless an admin chose to have artists and
 * albums below the films and series too (Settings → Music).
 */
export type SearchType = 'all' | 'movie' | 'tv' | 'music';

/** The kind of search in the address, if it is one this person can use. */
export const searchType = (
  value: string | string[] | undefined,
  musicOn: boolean
): SearchType =>
  value === 'movie' || value === 'tv' || (value === 'music' && musicOn)
    ? value
    : 'all';

/**
 * Whether this person's All has music below the films and series: when an
 * admin chose it, and never with music off for everyone or for themselves.
 * A server that does not say leaves it out, as it was before the choice.
 */
export const musicInAll = (
  musicOn: boolean,
  chosen: { inAll?: boolean } | undefined
): boolean => musicOn && (chosen?.inAll ?? false);

/**
 * Whether artists and albums go below a search's films and series: in All
 * only, and only once the films and series are there, so music (which
 * MusicBrainz answers slowly) never holds them up or comes before them.
 */
export const musicBelowTitles = (
  type: SearchType,
  inAll: boolean,
  titlesLoaded: boolean
): boolean => type === 'all' && inAll && titlesLoaded;
