import type TheMovieDb from '@server/api/themoviedb';

/** What the list pages and their notifications show of a title. */
export interface ListTitle {
  title: string;
  posterPath?: string;
  /** A film's release date, or a series' first air date. */
  releaseDate: string;
  /** A series' episodes, not counting specials. Absent for a film. */
  totalEpisodes?: number;
}

/**
 * A film's or a series' details from TMDB: a film when `mediaType` is
 * 'movie', otherwise a series. Throws as TMDB does.
 */
export const listTitle = async (
  tmdb: TheMovieDb,
  tmdbId: number,
  mediaType: string | undefined
): Promise<ListTitle> => {
  if (mediaType === 'movie') {
    const movie = await tmdb.getMovie({ movieId: tmdbId });
    return {
      title: movie.title,
      posterPath: movie.poster_path,
      releaseDate: movie.release_date,
    };
  }

  const tv = await tmdb.getTvShow({ tvId: tmdbId });
  return {
    title: tv.name,
    posterPath: tv.poster_path,
    releaseDate: tv.first_air_date,
    totalEpisodes: (tv.seasons ?? [])
      .filter((season) => season.season_number > 0)
      .reduce((total, season) => total + (season.episode_count ?? 0), 0),
  };
};
