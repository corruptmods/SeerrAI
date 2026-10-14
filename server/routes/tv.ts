import { getMetadataProvider } from '@server/api/metadata';
import IMDBGraphQL from '@server/api/rating/imdbGraphql';
import RottenTomatoes from '@server/api/rating/rottentomatoes';
import type { RatingResponse } from '@server/api/ratings';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Episode from '@server/entity/Episode';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { Watchlist } from '@server/entity/Watchlist';
import { detectAnime } from '@server/lib/animeDecision';
import { featureEnabled } from '@server/lib/features';
import {
  SeriesFinishedError,
  canSubscribe,
  getSubscription,
  subscribe,
  unsubscribe,
} from '@server/lib/futureSeasons';
import mediaForViewer from '@server/lib/mediaForViewer';
import logger from '@server/logger';
import { mapTvResult } from '@server/models/Search';
import type { SeasonRequestCoverage } from '@server/models/Tv';
import { mapSeasonWithEpisodes, mapTvDetails } from '@server/models/Tv';
import { Router } from 'express';
import { In } from 'typeorm';

const tvRoutes = Router();

tvRoutes.get('/:id', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const tmdbTv = await tmdb.getTvShow({
      tvId: Number(req.params.id),
    });
    const metadataProvider = detectAnime(tmdbTv)
      ? await getMetadataProvider('anime')
      : await getMetadataProvider('tv');
    const tv = await metadataProvider.getTvShow({
      tvId: Number(req.params.id),
      language: (req.query.language as string) ?? req.locale,
    });
    const media = await Media.getMedia(tv.id, MediaType.TV);

    const onUserWatchlist = await getRepository(Watchlist).exist({
      where: {
        tmdbId: Number(req.params.id),
        mediaType: MediaType.TV,
        requestedBy: {
          id: req.user?.id,
        },
      },
    });

    const data = mapTvDetails(
      tv,
      mediaForViewer(media, req.user),
      onUserWatchlist
    );

    // TMDB issue where it doesnt fallback to English when no overview is available in requested locale.
    if (!data.overview) {
      const tvEnglish = await metadataProvider.getTvShow({
        tvId: Number(req.params.id),
      });
      data.overview = tvEnglish.overview;
    }

    return res.status(200).json(data);
  } catch (e) {
    logger.debug('Something went wrong retrieving series', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve series.',
    });
  }
});

tvRoutes.get('/:id/season/:seasonNumber', async (req, res, next) => {
  try {
    const tmdb = new TheMovieDb();
    const tmdbTv = await tmdb.getTvShow({
      tvId: Number(req.params.id),
    });
    const metadataProvider = detectAnime(tmdbTv)
      ? await getMetadataProvider('anime')
      : await getMetadataProvider('tv');

    const season = await metadataProvider.getTvSeason({
      tvId: Number(req.params.id),
      seasonNumber: Number(req.params.seasonNumber),
      language: (req.query.language as string) ?? req.locale,
    });

    // Per-episode availability, when episode tracking has populated it.
    const availability = new Map<
      number,
      { available: boolean; available4k: boolean }
    >();

    const media = await getRepository(Media).findOne({
      where: { tmdbId: Number(req.params.id), mediaType: MediaType.TV },
      relations: { seasons: true },
    });

    const mediaSeason = media?.seasons.find(
      (s) => s.seasonNumber === Number(req.params.seasonNumber)
    );

    if (mediaSeason) {
      const episodeRows: Episode[] = await getRepository(Episode).find({
        where: { season: { id: mediaSeason.id } },
      });

      for (const row of episodeRows) {
        availability.set(row.episodeNumber, {
          available: row.status === MediaStatus.AVAILABLE,
          available4k: row.status4k === MediaStatus.AVAILABLE,
        });
      }
    }

    // Which episodes active requests already cover, so a Request button is
    // never offered for one that is on its way. A season request without
    // episodes covers the whole season.
    const requested: SeasonRequestCoverage = {
      wholeSeason: false,
      episodes: new Set(),
      wholeSeason4k: false,
      episodes4k: new Set(),
    };

    if (media) {
      const activeRequests = await getRepository(MediaRequest).find({
        where: {
          media: { id: media.id },
          status: In([MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED]),
        },
        relations: { seasons: { episodes: true } },
      });

      for (const request of activeRequests) {
        for (const seasonRequest of request.seasons) {
          if (seasonRequest.seasonNumber !== Number(req.params.seasonNumber)) {
            continue;
          }

          if (!seasonRequest.episodes?.length) {
            if (request.is4k) {
              requested.wholeSeason4k = true;
            } else {
              requested.wholeSeason = true;
            }
          } else {
            for (const episode of seasonRequest.episodes) {
              (request.is4k ? requested.episodes4k : requested.episodes).add(
                episode.episodeNumber
              );
            }
          }
        }
      }
    }

    return res
      .status(200)
      .json(mapSeasonWithEpisodes(season, availability, requested));
  } catch (e) {
    logger.debug('Something went wrong retrieving season', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
      seasonNumber: req.params.seasonNumber,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve season.',
    });
  }
});

tvRoutes.get('/:id/recommendations', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.getTvRecommendations({
      tvId: Number(req.params.id),
      page: Number(req.query.page),
      language: (req.query.language as string) ?? req.locale,
    });

    const media = await Media.getRelatedMedia(
      req.user,
      results.results.map((result) => ({
        tmdbId: result.id,
        mediaType: MediaType.TV,
      })),
      { includeActiveRequest: true }
    );

    return res.status(200).json({
      page: results.page,
      totalPages: results.total_pages,
      totalResults: results.total_results,
      results: results.results.map((result) =>
        mapTvResult(
          result,
          media.find(
            (req) => req.tmdbId === result.id && req.mediaType === MediaType.TV
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving series recommendations', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve series recommendations.',
    });
  }
});

tvRoutes.get('/:id/similar', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.getTvSimilar({
      tvId: Number(req.params.id),
      page: Number(req.query.page),
      language: (req.query.language as string) ?? req.locale,
    });

    const media = await Media.getRelatedMedia(
      req.user,
      results.results.map((result) => ({
        tmdbId: result.id,
        mediaType: MediaType.TV,
      })),
      { includeActiveRequest: true }
    );

    return res.status(200).json({
      page: results.page,
      totalPages: results.total_pages,
      totalResults: results.total_results,
      results: results.results.map((result) =>
        mapTvResult(
          result,
          media.find(
            (req) => req.tmdbId === result.id && req.mediaType === MediaType.TV
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving similar series', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve similar series.',
    });
  }
});

tvRoutes.get('/:id/ratings', async (req, res, next) => {
  const tmdb = new TheMovieDb();
  const rtapi = new RottenTomatoes();

  try {
    const tv = await tmdb.getTvShow({
      tvId: Number(req.params.id),
    });

    const rtratings = await rtapi.getTVRatings(
      tv.name,
      tv.first_air_date ? Number(tv.first_air_date.slice(0, 4)) : undefined
    );

    if (!rtratings) {
      return next({
        status: 404,
        message: 'Rotten Tomatoes ratings not found.',
      });
    }

    return res.status(200).json(rtratings);
  } catch (e) {
    logger.debug('Something went wrong retrieving series ratings', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve series ratings.',
    });
  }
});

/**
 * Rotten Tomatoes and IMDb together, as for movies. Either source can be
 * down or not know the series; the other is still returned.
 */
tvRoutes.get('/:id/ratingscombined', async (req, res, next) => {
  const tmdb = new TheMovieDb();
  const rtapi = new RottenTomatoes();
  const imdbApi = new IMDBGraphQL();

  try {
    const tv = await tmdb.getTvShow({
      tvId: Number(req.params.id),
    });
    const imdbId = tv.external_ids?.imdb_id;

    const [rt, imdb] = await Promise.allSettled([
      rtapi.getTVRatings(
        tv.name,
        tv.first_air_date ? Number(tv.first_air_date.slice(0, 4)) : undefined
      ),
      imdbId ? imdbApi.getRatings(imdbId) : Promise.resolve(null),
    ]);

    for (const result of [rt, imdb]) {
      if (result.status === 'rejected') {
        logger.debug('A ratings source failed for a series', {
          label: 'API',
          errorMessage: (result.reason as Error)?.message,
          tvId: req.params.id,
        });
      }
    }

    const rtratings = rt.status === 'fulfilled' ? rt.value : null;
    const imdbRatings = imdb.status === 'fulfilled' ? imdb.value : null;

    if (!rtratings && !imdbRatings) {
      return next({
        status: 404,
        message: 'No ratings found.',
      });
    }

    const ratings: RatingResponse = {
      ...(rtratings ? { rt: rtratings } : {}),
      ...(imdbRatings ? { imdb: imdbRatings } : {}),
    };

    return res.status(200).json(ratings);
  } catch (e) {
    logger.debug('Something went wrong retrieving series ratings', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve series ratings.',
    });
  }
});

/*
 * Getting a series' new seasons as they premiere, for the signed-in user.
 */
tvRoutes.get<{ id: string }>('/:id/future-seasons', async (req, res, next) => {
  try {
    const subscription = await getSubscription(
      req.user?.id as number,
      Number(req.params.id)
    );
    return res
      .status(200)
      .json(
        subscription
          ? { following: true, fromSeason: subscription.fromSeason }
          : { following: false }
      );
  } catch (e) {
    return next({ status: 500, message: e.message });
  }
});

tvRoutes.post<{ id: string }>('/:id/future-seasons', async (req, res, next) => {
  if (!req.user || !canSubscribe(req.user)) {
    return next({
      status: 403,
      message: 'You do not have permission to request series.',
    });
  }
  if (!featureEnabled('newSeasons', req.user)) {
    return next({ status: 403, message: 'Getting new seasons is turned off.' });
  }

  try {
    const subscription = await subscribe(req.user, Number(req.params.id));
    return res
      .status(201)
      .json({ following: true, fromSeason: subscription.fromSeason });
  } catch (e) {
    if (e instanceof SeriesFinishedError) {
      return next({ status: 400, message: e.message });
    }
    logger.debug('Could not follow a series for new seasons', {
      label: 'API',
      tmdbId: req.params.id,
      errorMessage: e.message,
    });
    return next({ status: 500, message: 'Unable to follow this series.' });
  }
});

tvRoutes.delete<{ id: string }>(
  '/:id/future-seasons',
  async (req, res, next) => {
    try {
      await unsubscribe(req.user?.id as number, Number(req.params.id));
      return res.status(204).send();
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

export default tvRoutes;
