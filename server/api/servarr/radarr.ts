import logger from '@server/logger';
import type { AxiosResponse } from 'axios';
import ServarrBase from './base';

export interface RadarrMovieOptions {
  title: string;
  qualityProfileId: number;
  minimumAvailability: string;
  tags: number[];
  profileId: number;
  year: number;
  rootFolderPath: string;
  tmdbId: number;
  monitored?: boolean;
  searchNow?: boolean;
}

export interface RadarrMovie {
  id: number;
  title: string;
  isAvailable: boolean;
  /** 'announced', 'inCinemas' or 'released'. */
  minimumAvailability?: string;
  inCinemas?: string;
  digitalRelease?: string;
  physicalRelease?: string;
  year?: number;
  /** TMDB runtime in minutes. */
  runtime?: number;
  images?: { coverType: string; remoteUrl?: string; url?: string }[];
  monitored: boolean;
  tmdbId: number;
  imdbId: string;
  titleSlug: string;
  folderName: string;
  path: string;
  profileId: number;
  qualityProfileId: number;
  added: string;
  hasFile: boolean;
  tags: number[];
  movieFile?: {
    id: number;
    movieId: number;
    relativePath?: string;
    path?: string;
    size: number;
    dateAdded: string;
    sceneName?: string;
    releaseGroup?: string;
    edition?: string;
    indexerFlags?: number;
    mediaInfo: {
      id: number;
      audioBitrate: number;
      audioChannels: number;
      audioCodec?: string;
      audioLanguages?: string;
      audioStreamCount: number;
      videoBitDepth: number;
      videoBitrate: number;
      videoCodec?: string;
      videoFps: number;
      videoDynamicRange?: string;
      videoDynamicRangeType?: string;
      resolution?: string;
      runTime?: string;
      scanType?: string;
      subtitles?: string;
    };
    originalFilePath?: string;
    qualityCutoffNotMet: boolean;
  };
}

class RadarrAPI extends ServarrBase<{ movieId: number }> {
  constructor({ url, apiKey }: { url: string; apiKey: string }) {
    super({ url, apiKey, cacheName: 'radarr', apiName: 'Radarr' });
  }

  public getMovies = async (): Promise<RadarrMovie[]> => {
    try {
      const response = await this.axios.get<RadarrMovie[]>('/movie');

      return response.data;
    } catch (e) {
      throw new Error(`[Radarr] Failed to retrieve movies: ${e.message}`, {
        cause: e,
      });
    }
  };

  public getLibraryMoviesByTmdbId = async (
    tmdbId: number
  ): Promise<RadarrMovie[]> => {
    try {
      const response = await this.axios.get<RadarrMovie[]>('/movie', {
        params: { tmdbId },
      });

      return response.data;
    } catch (e) {
      throw new Error(
        `[Radarr] Failed to retrieve movies by TMDB ID: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getMovie = async ({ id }: { id: number }): Promise<RadarrMovie> => {
    try {
      const response = await this.axios.get<RadarrMovie>(`/movie/${id}`);

      return response.data;
    } catch (e) {
      throw new Error(`[Radarr] Failed to retrieve movie: ${e.message}`, {
        cause: e,
      });
    }
  };

  public async getMovieByTmdbId(id: number): Promise<RadarrMovie> {
    let response: AxiosResponse<RadarrMovie[]>;
    try {
      response = await this.axios.get<RadarrMovie[]>('/movie/lookup', {
        params: {
          term: `tmdb:${id}`,
        },
      });
    } catch (e) {
      logger.error('Error retrieving movie by TMDB ID', {
        label: 'Radarr API',
        errorMessage: e.message,
        tmdbId: id,
      });
      throw e;
    }

    if (!response.data[0]) {
      throw new Error('Movie not found');
    }

    return response.data[0];
  }

  public addMovie = async (
    options: RadarrMovieOptions
  ): Promise<RadarrMovie> => {
    try {
      const movie = await this.getMovieByTmdbId(options.tmdbId);

      if (movie.hasFile) {
        logger.info(
          'Title already exists and is available. Skipping add and returning success',
          {
            label: 'Radarr',
            movie,
          }
        );
        return movie;
      }

      // In Radarr but neither downloaded nor monitored.
      if (movie.id && !movie.monitored) {
        const response = await this.axios.put<RadarrMovie>(`/movie`, {
          ...movie,
          title: options.title,
          qualityProfileId: options.qualityProfileId,
          profileId: options.profileId,
          titleSlug: options.tmdbId.toString(),
          minimumAvailability: options.minimumAvailability,
          tmdbId: options.tmdbId,
          year: options.year,
          tags: Array.from(new Set([...movie.tags, ...options.tags])),
          rootFolderPath: options.rootFolderPath,
          monitored: options.monitored,
          // searchIfAvailable searches only once Radarr says it's available.
          addOptions: {
            searchForMovie: false,
          },
        });

        if (response.data.monitored) {
          logger.info(
            'Found existing title in Radarr and set it to monitored.',
            {
              label: 'Radarr',
              movieId: response.data.id,
              movieTitle: response.data.title,
            }
          );
          logger.debug('Radarr update details', {
            label: 'Radarr',
            movie: response.data,
          });

          this.searchIfAvailable(response.data, options);

          return response.data;
        } else {
          logger.error('Failed to update existing movie in Radarr.', {
            label: 'Radarr',
            options,
          });
          throw new Error('Failed to update existing movie in Radarr');
        }
      }

      if (movie.id) {
        logger.info('Movie is already monitored in Radarr.', {
          label: 'Radarr',
          movieId: movie.id,
          movieTitle: movie.title,
          hasFile: movie.hasFile,
        });

        this.searchIfAvailable(movie, options);

        return movie;
      }

      const response = await this.axios.post<RadarrMovie>(`/movie`, {
        title: options.title,
        qualityProfileId: options.qualityProfileId,
        profileId: options.profileId,
        titleSlug: options.tmdbId.toString(),
        minimumAvailability: options.minimumAvailability,
        tmdbId: options.tmdbId,
        year: options.year,
        rootFolderPath: options.rootFolderPath,
        monitored: options.monitored,
        tags: options.tags,
        // Radarr would search on add even if unavailable; searchIfAvailable
        // searches only once it is available.
        addOptions: {
          searchForMovie: false,
        },
      });

      if (response.data.id) {
        logger.info('Radarr accepted request', { label: 'Radarr' });
        logger.debug('Radarr add details', {
          label: 'Radarr',
          movie: response.data,
        });
        this.searchIfAvailable(response.data, options);
      } else {
        logger.error('Failed to add movie to Radarr', {
          label: 'Radarr',
          options,
        });
        throw new Error('Failed to add movie to Radarr');
      }
      return response.data;
    } catch (e) {
      logger.error(
        'Failed to add movie to Radarr. This might happen if the movie already exists, in which case you can safely ignore this error.',
        {
          label: 'Radarr',
          errorMessage: e.message,
          options,
          response: e?.response?.data,
        }
      );
      throw new Error('Failed to add movie to Radarr', { cause: e });
    }
  };

  /**
   * Searches now if Radarr says the movie is available (from its Minimum
   * Availability and delay). Otherwise it stays monitored and Radarr grabs it
   * later. A manual search ignores Minimum Availability, so searching early
   * could grab a release the admin chose to wait past, such as a cam.
   */
  private searchIfAvailable(
    movie: RadarrMovie,
    options: RadarrMovieOptions
  ): void {
    if (!options.searchNow) {
      return;
    }
    // Without isAvailable (older Radarr), search rather than wait forever.
    if (movie.isAvailable === false) {
      logger.info(
        'Movie is not available yet in Radarr; it stays monitored and Radarr will grab it once it is',
        {
          label: 'Radarr',
          movieId: movie.id,
          movieTitle: movie.title,
          minimumAvailability: movie.minimumAvailability,
        }
      );
      return;
    }
    logger.info('Movie is available in Radarr; searching for it now', {
      label: 'Radarr',
      movieId: movie.id,
      movieTitle: movie.title,
    });
    this.searchMovie(movie.id);
  }

  /**
   * Changes a movie's root folder or quality profile via Radarr's movie
   * editor. A new root folder moves the files; Radarr does it in the
   * background.
   */
  public async editMovie(
    movieId: number,
    changes: { rootFolderPath?: string; qualityProfileId?: number }
  ): Promise<void> {
    try {
      await this.axios.put('/movie/editor', {
        movieIds: [movieId],
        ...changes,
        moveFiles: changes.rootFolderPath !== undefined,
      });
    } catch (e) {
      throw new Error(`[Radarr] Failed to edit movie: ${e.message}`, {
        cause: e,
      });
    }
  }

  public async searchMovie(movieId: number): Promise<void> {
    logger.info('Executing movie search command', {
      label: 'Radarr API',
      movieId,
    });

    try {
      await this.runCommand('MoviesSearch', { movieIds: [movieId] });
    } catch (e) {
      logger.error(
        'Something went wrong while executing Radarr movie search.',
        {
          label: 'Radarr API',
          errorMessage: e.message,
          movieId,
        }
      );
    }
  }
  /**
   * Searches several movies in one command and throws on failure, unlike
   * searchMovie, which logs and continues as the request flow expects. For
   * when the user pressing Search must learn it did not start.
   */
  public async searchMovies(movieIds: number[]): Promise<void> {
    if (!movieIds.length) {
      return;
    }
    await this.runCommand('MoviesSearch', { movieIds });
  }

  /**
   * Monitored movies with a cinema, digital or physical release in the
   * range, from Radarr's calendar.
   */
  public async getCalendar(start: Date, end: Date): Promise<RadarrMovie[]> {
    const response = await this.axios.get<RadarrMovie[]>('/calendar', {
      params: {
        start: start.toISOString(),
        end: end.toISOString(),
        unmonitored: false,
      },
    });
    return response.data;
  }

  public removeMovie = async (
    tmdbId: number,
    {
      addImportExclusion = false,
    }: {
      /**
       * Also stop the *arr's import lists re-adding it. Set when blocklisting;
       * plain file removal leaves it off.
       */
      addImportExclusion?: boolean;
    } = {}
  ): Promise<void> => {
    const { id, title } = await this.getMovieByTmdbId(tmdbId);

    if (!id) {
      logger.info(`[Radarr] Movie not in library, nothing to remove`, {
        tmdbId,
      });
      return;
    }

    try {
      await this.axios.delete(`/movie/${id}`, {
        params: {
          deleteFiles: true,
          addImportExclusion,
        },
      });
      logger.info(`[Radarr] Removed movie ${title}`);
    } catch (e) {
      if (e?.response?.status === 404) {
        logger.info(`[Radarr] Movie already removed from Radarr`, {
          tmdbId,
        });
        return;
      }
      throw e;
    }
  };

  public clearCache = ({
    tmdbId,
    externalId,
  }: {
    tmdbId?: number | null;
    externalId?: number | null;
  }) => {
    if (tmdbId) {
      this.removeCache('/movie/lookup', {
        term: `tmdb:${tmdbId}`,
      });
    }
    if (externalId) {
      this.removeCache(`/movie/${externalId}`);
    }
  };
}

export default RadarrAPI;
