import TautulliAPI from '@server/api/tautulli';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaEvent from '@server/entity/MediaEvent';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import type {
  MediaResultsResponse,
  MediaWatchDataResponse,
} from '@server/interfaces/api/mediaInterfaces';
import type {
  AnimePlacement,
  AnimePlacementResult,
} from '@server/lib/animePlacement';
import { getAnimePlacement, setAnimeSetting } from '@server/lib/animePlacement';
import { NoArrServerError, removeFromArr } from '@server/lib/arrRemoval';
import { featureEnabled } from '@server/lib/features';
import { recordMediaDeletion } from '@server/lib/mediaDeletions';
import { MediaEventType, recordMediaEvent } from '@server/lib/mediaHistory';
import { Permission } from '@server/lib/permissions';
import { defaultRegion, estimateTitle } from '@server/lib/requestEta';
import {
  NotInServiceError,
  NothingMissingError,
  searchMissing,
} from '@server/lib/searchMissing';
import { getSettings } from '@server/lib/settings';
import { getWatchedBy } from '@server/lib/watchedBy';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { pageOf } from '@server/utils/pagination';
import { Router } from 'express';
import type { FindOneOptions } from 'typeorm';
import { EntityNotFoundError, In, IsNull, Not } from 'typeorm';

const mediaRoutes = Router();

mediaRoutes.get('/', async (req, res, next) => {
  const mediaRepository = getRepository(Media);

  const { pageSize, skip } = pageOf(req.query, 20);

  let statusFilter = undefined;

  switch (req.query.filter) {
    case 'available':
      statusFilter = MediaStatus.AVAILABLE;
      break;
    case 'partial':
      statusFilter = MediaStatus.PARTIALLY_AVAILABLE;
      break;
    case 'allavailable':
      statusFilter = In([
        MediaStatus.AVAILABLE,
        MediaStatus.PARTIALLY_AVAILABLE,
      ]);
      break;
    case 'processing':
      statusFilter = MediaStatus.PROCESSING;
      break;
    case 'pending':
      statusFilter = MediaStatus.PENDING;
      break;
  }

  let sortFilter: FindOneOptions<Media>['order'] = {
    id: 'DESC',
  };

  switch (req.query.sort) {
    case 'modified':
      sortFilter = {
        updatedAt: 'DESC',
      };
      break;
    case 'mediaAdded':
      sortFilter = {
        mediaAddedAt: 'DESC',
      };
  }

  let whereClause: FindOneOptions<Media>['where'];
  if (statusFilter || req.query.sort === 'mediaAdded') {
    whereClause = {};
    if (statusFilter) whereClause.status = statusFilter;
    if (req.query.sort === 'mediaAdded')
      whereClause.mediaAddedAt = Not(IsNull());
  }

  try {
    const [media, mediaCount] = await mediaRepository.findAndCount({
      order: sortFilter,
      where: whereClause,
      take: pageSize,
      skip,
    });
    return res.status(200).json({
      pageInfo: {
        pages: Math.ceil(mediaCount / pageSize),
        pageSize,
        results: mediaCount,
        page: Math.ceil(skip / pageSize) + 1,
      },
      results: media,
    } as MediaResultsResponse);
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

/**
 * Asks Radarr or Sonarr to search now for what a title is missing — for a
 * series, only monitored episodes that have aired without a file.
 *
 * Registered before '/:id/:status', which would otherwise take
 * "search-missing" as a status.
 */
mediaRoutes.post<{ id: string }, unknown, { is4k?: boolean }>(
  '/:id/search-missing',
  isAuthenticated([Permission.MANAGE_REQUESTS, Permission.ADMIN], {
    type: 'or',
  }),
  async (req, res, next) => {
    try {
      const media = await getRepository(Media).findOne({
        where: { id: Number(req.params.id) },
      });
      if (!media) {
        return next({ status: 404, message: 'Media not found.' });
      }

      const is4k = !!req.body?.is4k;
      const started = await searchMissing(media, is4k);

      await recordMediaEvent({
        tmdbId: media.tmdbId,
        mediaType: media.mediaType,
        type: MediaEventType.SEARCHED,
        is4k,
        userId: req.user?.id,
        detail:
          media.mediaType === MediaType.MOVIE
            ? started.service
            : `${started.searched} missing ${
                started.searched === 1 ? 'episode' : 'episodes'
              }, in ${started.service}`,
      });

      return res.status(200).json(started);
    } catch (e) {
      if (e instanceof NotInServiceError || e instanceof NothingMissingError) {
        return next({ status: 409, message: e.message });
      }
      return next({
        status: 502,
        message: `Radarr or Sonarr did not accept the search: ${e.message}`,
      });
    }
  }
);

mediaRoutes.post<
  {
    id: string;
    status: 'available' | 'partial' | 'processing' | 'pending' | 'unknown';
  },
  Media
>(
  '/:id/:status',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const mediaRepository = getRepository(Media);
    const seasonRepository = getRepository(Season);

    const media = await mediaRepository.findOne({
      where: { id: Number(req.params.id) },
    });

    if (!media) {
      return next({ status: 404, message: 'Media does not exist.' });
    }

    const is4k = String(req.body.is4k) === 'true';

    switch (req.params.status) {
      case 'available':
        media[is4k ? 'status4k' : 'status'] = MediaStatus.AVAILABLE;

        if (media.mediaType === MediaType.TV) {
          const expectedSeasons = req.body.seasons ?? [];

          for (const expectedSeason of expectedSeasons) {
            let season = media.seasons.find(
              (s) => s.seasonNumber === expectedSeason?.seasonNumber
            );

            if (!season) {
              // Create the season if it doesn't exist
              season = seasonRepository.create({
                seasonNumber: expectedSeason?.seasonNumber,
              });
              media.seasons.push(season);
            }

            season[is4k ? 'status4k' : 'status'] = MediaStatus.AVAILABLE;
          }
        }
        break;
      case 'partial':
        if (media.mediaType === MediaType.MOVIE) {
          return next({
            status: 400,
            message: 'Only series can be set to be partially available',
          });
        }
        media[is4k ? 'status4k' : 'status'] = MediaStatus.PARTIALLY_AVAILABLE;
        break;
      case 'processing':
        media[is4k ? 'status4k' : 'status'] = MediaStatus.PROCESSING;
        break;
      case 'pending':
        media[is4k ? 'status4k' : 'status'] = MediaStatus.PENDING;
        break;
      case 'unknown':
        media[is4k ? 'status4k' : 'status'] = MediaStatus.UNKNOWN;
    }

    await mediaRepository.save(media);

    return res.status(200).json(media);
  }
);

mediaRoutes.delete(
  '/:id',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    try {
      const mediaRepository = getRepository(Media);

      const media = await mediaRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });

      // Recorded before the row goes, so watchlist sync can still tell a
      // stale watchlist entry from one added after this deletion.
      await recordMediaDeletion(media.tmdbId, media.mediaType);

      if (media.status === MediaStatus.BLOCKLISTED) {
        media.resetServiceData();
        await mediaRepository.save(media);
      } else {
        await mediaRepository.remove(media);
      }

      return res.status(204).send();
    } catch (e) {
      if (e instanceof EntityNotFoundError) {
        return res.status(204).send();
      }
      logger.error('Something went wrong deleting media', {
        label: 'Media',
        mediaId: req.params.id,
        message: e.message,
      });
      next({ status: 500, message: 'Failed to delete media' });
    }
  }
);

/**
 * A title's history, newest first, for the manage panel. Looked up by title
 * rather than media id, so it outlives the media row.
 */
mediaRoutes.get(
  '/history/:mediaType/:tmdbId',
  isAuthenticated([Permission.MANAGE_REQUESTS, Permission.ADMIN], {
    type: 'or',
  }),
  async (req, res, next) => {
    const mediaType = req.params.mediaType;
    if (mediaType !== MediaType.MOVIE && mediaType !== MediaType.TV) {
      return next({ status: 400, message: 'Unknown media type.' });
    }

    try {
      const events = await getRepository(MediaEvent).find({
        where: { tmdbId: Number(req.params.tmdbId), mediaType },
        order: { occurredAt: 'DESC', id: 'DESC' },
        take: 100,
      });

      const userIds = [
        ...new Set(events.map((e) => e.userId).filter((id) => id != null)),
      ] as number[];
      const users = userIds.length
        ? await getRepository(User).find({ where: { id: In(userIds) } })
        : [];
      const byId = new Map(users.map((user) => [user.id, user]));

      return res.status(200).json(
        events.map((event) => {
          const user = event.userId != null ? byId.get(event.userId) : null;
          return {
            id: event.id,
            type: event.type,
            is4k: event.is4k,
            detail: event.detail ?? null,
            occurredAt: event.occurredAt,
            user: user
              ? {
                  id: user.id,
                  displayName: user.displayName,
                  avatar: user.avatar,
                }
              : null,
          };
        })
      );
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

mediaRoutes.delete(
  '/:id/file',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    try {
      const mediaRepository = getRepository(Media);
      const media = await mediaRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });

      const is4k = String(req.query.is4k) === 'true';

      try {
        await removeFromArr(media, is4k);
        await recordMediaEvent({
          tmdbId: media.tmdbId,
          mediaType: media.mediaType,
          type: MediaEventType.FILES_REMOVED,
          is4k,
          userId: req.user?.id,
          detail: media.mediaType === MediaType.MOVIE ? 'Radarr' : 'Sonarr',
        });
      } catch (e) {
        if (e instanceof NoArrServerError) {
          return next({ status: 409, message: e.message });
        }

        throw e;
      }

      if (media.mediaType === MediaType.TV) {
        for (const season of media.seasons) {
          season[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
        }
      }

      media[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
      media.resetServiceData(is4k);
      await mediaRepository.save(media);
      await recordMediaDeletion(media.tmdbId, media.mediaType);

      return res.status(204).send();
    } catch (e) {
      if (e instanceof EntityNotFoundError) {
        return next({ status: 404, message: 'Media not found' });
      }
      logger.error('Something went wrong deleting media file', {
        label: 'Media',
        mediaId: req.params.id,
        message: e.message,
      });
      next({ status: 500, message: 'Failed to delete media file' });
    }
  }
);

/**
 * Roughly when a title should arrive, for one being processed with no
 * request behind it — added in Radarr or Sonarr directly, say. Seerr shows it
 * as "Requested" all the same; with a request, the request's own estimate is
 * used instead.
 */
mediaRoutes.get<{ id: string }>('/:id/eta', async (req, res, next) => {
  // Switched off for everyone or by this person: nothing to estimate.
  if (!featureEnabled('arrivalEstimates', req.user)) {
    return res.status(200).json({ stage: 'unknown' });
  }
  try {
    const media = await getRepository(Media).findOne({
      where: { id: Number(req.params.id) },
    });
    if (!media) {
      return next({ status: 404, message: 'Media not found.' });
    }
    return res.status(200).json(
      await estimateTitle(
        media,
        // The validator may already have made it a boolean.
        String(req.query.is4k) === 'true',
        req.user?.settings?.discoverRegion || defaultRegion()
      )
    );
  } catch (e) {
    return next({ status: 500, message: e.message });
  }
});

/**
 * Who has watched a title, and when last, from Tautulli — for the title page.
 * Admins only, as the watch data behind the manage panel is.
 */
mediaRoutes.get<{ id: string }>(
  '/:id/watched-by',
  isAuthenticated(Permission.ADMIN),
  async (req, res, next) => {
    try {
      // Turned off: Tautulli is not asked who watched anything.
      if (!featureEnabled('whoWatched', req.user)) {
        return res.status(200).json({ configured: false, people: [] });
      }
      const media = await getRepository(Media).findOne({
        where: { id: Number(req.params.id) },
      });
      if (!media) {
        return next({ status: 404, message: 'Media not found.' });
      }
      const people = await getWatchedBy(media);
      return res
        .status(200)
        .json({ configured: people !== undefined, people: people ?? [] });
    } catch (e) {
      return next({
        status: 502,
        message: `Could not read Tautulli: ${e.message}`,
      });
    }
  }
);

/**
 * A title's anime setting and where it sits in Sonarr or Radarr against it,
 * for the manage panel (lib/animePlacement).
 */
mediaRoutes.get<{ id: string }, AnimePlacement>(
  '/:id/anime',
  isAuthenticated(Permission.ADMIN),
  async (req, res, next) => {
    try {
      return res
        .status(200)
        .json(await getAnimePlacement(Number(req.params.id)));
    } catch (e) {
      if (e instanceof EntityNotFoundError) {
        return next({ status: 404, message: 'Media not found.' });
      }
      logger.error('Could not read where a title sits for anime', {
        label: 'API',
        mediaId: req.params.id,
        errorMessage: e.message,
      });
      return next({ status: 500, message: e.message });
    }
  }
);

/**
 * Sets a title anime (true), not anime (false) or back to automatic (null),
 * and moves it in Sonarr or Radarr to match.
 */
mediaRoutes.put<
  { id: string },
  AnimePlacementResult,
  { animeSetting?: unknown }
>('/:id/anime', isAuthenticated(Permission.ADMIN), async (req, res, next) => {
  const { animeSetting } = req.body ?? {};
  if (
    animeSetting !== true &&
    animeSetting !== false &&
    animeSetting !== null
  ) {
    return next({
      status: 400,
      message: 'animeSetting must be true, false or null.',
    });
  }
  try {
    return res
      .status(200)
      .json(await setAnimeSetting(Number(req.params.id), animeSetting));
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      return next({ status: 404, message: 'Media not found.' });
    }
    logger.error("Could not save a title's anime setting", {
      label: 'API',
      mediaId: req.params.id,
      errorMessage: e.message,
    });
    return next({ status: 500, message: e.message });
  }
});

mediaRoutes.get<{ id: string }, MediaWatchDataResponse>(
  '/:id/watch_data',
  isAuthenticated(Permission.ADMIN),
  async (req, res, next) => {
    const settings = getSettings().tautulli;

    if (!settings.hostname || !settings.port || !settings.apiKey) {
      return next({
        status: 404,
        message: 'Tautulli API not configured.',
      });
    }

    const media = await getRepository(Media).findOne({
      where: { id: Number(req.params.id) },
    });

    if (!media) {
      return next({ status: 404, message: 'Media does not exist.' });
    }

    try {
      const tautulli = new TautulliAPI(settings);
      const userRepository = getRepository(User);

      const response: MediaWatchDataResponse = {};

      if (media.ratingKey) {
        const watchStats = await tautulli.getMediaWatchStats(media.ratingKey);
        const watchUsers = await tautulli.getMediaWatchUsers(media.ratingKey);
        const plexIds = watchUsers.map((u) => u.user_id);
        if (!plexIds.length) plexIds.push(-1);

        const users = await userRepository
          .createQueryBuilder('user')
          .where('user.plexId IN (:...plexIds)', { plexIds })
          .getMany();

        const playCount =
          watchStats.find((i) => i.query_days == 0)?.total_plays ?? 0;

        const playCount7Days =
          watchStats.find((i) => i.query_days == 7)?.total_plays ?? 0;

        const playCount30Days =
          watchStats.find((i) => i.query_days == 30)?.total_plays ?? 0;

        response.data = {
          users: users,
          playCount,
          playCount7Days,
          playCount30Days,
        };
      }

      if (media.ratingKey4k) {
        const watchStats4k = await tautulli.getMediaWatchStats(
          media.ratingKey4k
        );
        const watchUsers4k = await tautulli.getMediaWatchUsers(
          media.ratingKey4k
        );
        const plexIds4k = watchUsers4k.map((u) => u.user_id);
        if (!plexIds4k.length) plexIds4k.push(-1);

        const users = await userRepository
          .createQueryBuilder('user')
          .where('user.plexId IN (:...plexIds)', { plexIds: plexIds4k })
          .getMany();

        const playCount =
          watchStats4k.find((i) => i.query_days == 0)?.total_plays ?? 0;

        const playCount7Days =
          watchStats4k.find((i) => i.query_days == 7)?.total_plays ?? 0;

        const playCount30Days =
          watchStats4k.find((i) => i.query_days == 30)?.total_plays ?? 0;

        response.data4k = {
          users,
          playCount,
          playCount7Days,
          playCount30Days,
        };
      }

      return res.status(200).json(response);
    } catch (e) {
      logger.error('Something went wrong fetching media watch data', {
        label: 'API',
        errorMessage: e.message,
        mediaId: req.params.id,
      });
      next({ status: 500, message: 'Failed to fetch watch data.' });
    }
  }
);

export default mediaRoutes;
