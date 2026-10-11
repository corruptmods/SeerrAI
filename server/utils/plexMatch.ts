/*
 * Telling titles apart in the Plex Match Check, shared by the server and
 * the title page. No imports: the browser bundle uses it too.
 */

export interface MatchIds {
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
}

/** The id each side goes by first: TVDB for series, TMDB for movies. */
export const mainId = (
  kind: 'movie' | 'series',
  ids: MatchIds
): { name: 'tmdb' | 'tvdb'; id: number } | undefined => {
  const id = kind === 'series' ? ids.tvdbId : ids.tmdbId;
  return id ? { name: kind === 'series' ? 'tvdb' : 'tmdb', id } : undefined;
};

/** Same name and year, ignoring case: telling them apart needs the ids. */
export const sameName = (
  a: { title: string; year?: number },
  b: { title: string; year?: number }
): boolean =>
  a.title.trim().toLowerCase() === b.title.trim().toLowerCase() &&
  (a.year ?? null) === (b.year ?? null);
