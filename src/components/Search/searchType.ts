/**
 * What a search shows. Everything is films, series, collections and
 * people; music is on its own, unless an admin chose to have artists and
 * albums below the films and series too (Settings → Music).
 */
export type SearchType = 'all' | 'movie' | 'tv' | 'music';

/** The kind of search in the address, if it is one this person can use. */
export const searchType = (
  value: string | string[] | undefined,
  musicChip: boolean
): SearchType =>
  value === 'movie' || value === 'tv' || (value === 'music' && musicChip)
    ? value
    : 'all';

/** Where music can be searched. */
export interface MusicSearchPlaces {
  /** Artists and albums below the films and series in All. */
  inAll: boolean;
  /** The Music page's own search box. */
  musicPage: boolean;
  /** Music among the kinds on the search page. */
  chip: boolean;
}

/**
 * Where this person can search music: where an admin chose, and nowhere
 * at all with music off for everyone or for themselves. A server that
 * does not say keeps things as they were before there was a choice.
 */
export const musicSearchPlaces = (
  musicOn: boolean,
  chosen: Partial<MusicSearchPlaces> | undefined
): MusicSearchPlaces => ({
  inAll: musicOn && (chosen?.inAll ?? false),
  musicPage: musicOn && (chosen?.musicPage ?? true),
  chip: musicOn && (chosen?.chip ?? true),
});

/**
 * Whether artists and albums go below a search's films and series: in All
 * only, and only once the films and series are there, so music (which
 * MusicBrainz answers slowly) never holds them up or comes before them.
 */
export const musicBelowTitles = (
  type: SearchType,
  places: MusicSearchPlaces,
  titlesLoaded: boolean
): boolean => type === 'all' && places.inAll && titlesLoaded;

/**
 * Whether the search box at the top finds music: when Music is among the
 * kinds on the search page, or music comes below the films and series.
 */
export const searchFindsMusic = (places: MusicSearchPlaces): boolean =>
  places.chip || places.inAll;
