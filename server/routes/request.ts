import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { REQUEST_BATCH_LIMIT } from '@server/constants/lists';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { toSeriesTypeFor } from '@server/constants/seriesType';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  MediaRequest,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import { MediaRequestWatcher } from '@server/entity/MediaRequestWatcher';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import type {
  MediaRequestBody,
  RequestResultsResponse,
} from '@server/interfaces/api/requestInterfaces';
import { featureEnabled } from '@server/lib/features';
import { getNotificationChannels } from '@server/lib/notificationChannels';
import { Permission } from '@server/lib/permissions';
import { defaultRegion, estimateRequest } from '@server/lib/requestEta';
import { requestMissing } from '@server/lib/requestMissing';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { pageOf } from '@server/utils/pagination';
import requestLock, {
  mediaKey,
  mediaLock,
  requestKey,
  userKey,
} from '@server/utils/requestLock';
import { Router } from 'express';
import type { WhereExpressionBuilder } from 'typeorm';
import { Brackets, In } from 'typeorm';
import { z } from 'zod';

const requestRoutes = Router();

/*
 * Which server, quality profile, root folder, language profile and tags a
 * request uses are the advanced options. Only people allowed them may choose;
 * for everyone else the request gets the defaults, as their dialog shows.
 */
const mayChooseAdvancedOptions = (user?: User) =>
  !!user?.hasPermission(
    [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
    { type: 'or' }
  );

const withoutAdvancedOptions = (body: MediaRequestBody): MediaRequestBody => {
  const allowed = { ...body };
  delete allowed.serverId;
  delete allowed.profileId;
  delete allowed.rootFolder;
  delete allowed.languageProfileId;
  delete allowed.tags;
  return allowed;
};

requestRoutes.get<Record<string, unknown>, RequestResultsResponse>(
  '/',
  async (req, res, next) => {
    try {
      const { pageSize, skip } = pageOf(req.query, 10);
      // All three filters accept a comma-separated list so several values can
      // be ticked at once. A single value still works exactly as before.
      const splitParam = (value: unknown): string[] =>
        String(value ?? '')
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);

      const requestedByIds = splitParam(req.query.requestedBy)
        .map(Number)
        .filter((id) => Number.isFinite(id));

      const mediaTypes = splitParam(req.query.mediaType).filter(
        (type) => type === 'movie' || type === 'tv'
      );

      /**
       * Each filter is a pair of conditions — the request's own status and the
       * media's status — so they cannot be merged into two flat lists. Ticking
       * "available" and "failed" has to mean (completed AND available) OR
       * (failed AND anything), not (completed OR failed) AND (available OR
       * anything), which would let a failed-but-available request through.
       */
      const filterSpec = (
        filter: string
      ): { statuses: MediaRequestStatus[]; mediaStatuses: MediaStatus[] } => {
        const allMediaStatuses = [
          MediaStatus.UNKNOWN,
          MediaStatus.PENDING,
          MediaStatus.PROCESSING,
          MediaStatus.PARTIALLY_AVAILABLE,
          MediaStatus.AVAILABLE,
          MediaStatus.DELETED,
        ];
        const unavailableMediaStatuses = [
          MediaStatus.UNKNOWN,
          MediaStatus.PENDING,
          MediaStatus.PROCESSING,
          MediaStatus.PARTIALLY_AVAILABLE,
        ];

        switch (filter) {
          case 'approved':
            return {
              statuses: [MediaRequestStatus.APPROVED],
              mediaStatuses: allMediaStatuses,
            };
          case 'processing':
            return {
              statuses: [MediaRequestStatus.APPROVED],
              mediaStatuses: unavailableMediaStatuses,
            };
          case 'pending':
            return {
              statuses: [MediaRequestStatus.PENDING],
              mediaStatuses: allMediaStatuses,
            };
          case 'unavailable':
            return {
              statuses: [
                MediaRequestStatus.PENDING,
                MediaRequestStatus.APPROVED,
              ],
              mediaStatuses: unavailableMediaStatuses,
            };
          case 'failed':
            return {
              statuses: [MediaRequestStatus.FAILED],
              mediaStatuses: allMediaStatuses,
            };
          case 'completed':
            return {
              statuses: [MediaRequestStatus.COMPLETED],
              mediaStatuses: allMediaStatuses,
            };
          case 'available':
            return {
              statuses: [MediaRequestStatus.COMPLETED],
              mediaStatuses: [MediaStatus.AVAILABLE],
            };
          case 'deleted':
            return {
              statuses: [MediaRequestStatus.COMPLETED],
              mediaStatuses: [MediaStatus.DELETED],
            };
          default:
            return {
              statuses: [
                MediaRequestStatus.PENDING,
                MediaRequestStatus.APPROVED,
                MediaRequestStatus.DECLINED,
                MediaRequestStatus.FAILED,
                MediaRequestStatus.COMPLETED,
              ],
              mediaStatuses: allMediaStatuses,
            };
        }
      };

      const selectedFilters = splitParam(req.query.filter).filter(
        (filter) => filter !== 'all'
      );
      const filterSpecs = (
        selectedFilters.length ? selectedFilters : ['all']
      ).map(filterSpec);

      let sortFilter: string;
      let sortDirection: 'ASC' | 'DESC';

      switch (req.query.sort) {
        case 'modified':
          sortFilter = 'request.updatedAt';
          break;
        case 'added':
          sortFilter = 'request.createdAt';
          break;
        default:
          sortFilter = 'request.id';
      }

      switch (req.query.sortDirection) {
        case 'asc':
          sortDirection = 'ASC';
          break;
        default:
          sortDirection = 'DESC';
      }

      let query = getRepository(MediaRequest)
        .createQueryBuilder('request')
        .leftJoinAndSelect('request.media', 'media')
        .leftJoinAndSelect('request.seasons', 'seasons')
        .leftJoinAndSelect('request.modifiedBy', 'modifiedBy')
        .leftJoinAndSelect('request.requestedBy', 'requestedBy')
        .where(
          new Brackets((outer) => {
            filterSpecs.forEach((spec, index) => {
              const clause = (inner: WhereExpressionBuilder) =>
                inner
                  .where(`request.status IN (:...requestStatus${index})`, {
                    [`requestStatus${index}`]: spec.statuses,
                  })
                  .andWhere(
                    `((request.is4k = false AND media.status IN (:...mediaStatus${index})) OR (request.is4k = true AND media.status4k IN (:...mediaStatus${index})))`,
                    { [`mediaStatus${index}`]: spec.mediaStatuses }
                  );

              if (index === 0) {
                outer.where(new Brackets(clause));
              } else {
                outer.orWhere(new Brackets(clause));
              }
            });
          })
        );

      if (
        !req.user?.hasPermission(
          [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
          { type: 'or' }
        )
      ) {
        if (
          requestedByIds.length &&
          requestedByIds.some((id) => id !== req.user?.id)
        ) {
          return next({
            status: 403,
            message: "You do not have permission to view this user's requests.",
          });
        }

        query = query.andWhere('requestedBy.id = :id', {
          id: req.user?.id,
        });
      } else if (requestedByIds.length) {
        query = query.andWhere('requestedBy.id IN (:...requestedByIds)', {
          requestedByIds,
        });
      }

      // Ticking both is the same as ticking neither.
      if (mediaTypes.length && mediaTypes.length < 2) {
        query = query.andWhere('request.type = :type', {
          type: mediaTypes[0] === 'movie' ? MediaType.MOVIE : MediaType.TV,
        });
      }

      const [requests, requestCount] = await query
        .orderBy(sortFilter, sortDirection)
        .addOrderBy('request.id', sortDirection)
        .take(pageSize)
        .skip(skip)
        .getManyAndCount();

      const settings = getSettings();

      // get all quality profiles for every configured sonarr server
      const sonarrServers = await Promise.all(
        settings.sonarr.map(async (sonarrSetting) => {
          const sonarr = new SonarrAPI({
            apiKey: sonarrSetting.apiKey,
            url: SonarrAPI.buildUrl(sonarrSetting, '/api/v3'),
          });

          return {
            id: sonarrSetting.id,
            profiles: await sonarr.getProfiles().catch(() => undefined),
          };
        })
      );

      // get all quality profiles for every configured radarr server
      const radarrServers = await Promise.all(
        settings.radarr.map(async (radarrSetting) => {
          const radarr = new RadarrAPI({
            apiKey: radarrSetting.apiKey,
            url: RadarrAPI.buildUrl(radarrSetting, '/api/v3'),
          });

          return {
            id: radarrSetting.id,
            profiles: await radarr.getProfiles().catch(() => undefined),
          };
        })
      );

      // add profile names to the media requests, with undefined if not found
      let mappedRequests = requests.map((r) => {
        switch (r.type) {
          case MediaType.MOVIE: {
            const profileName = radarrServers
              .find((serverr) => serverr.id === r.serverId)
              ?.profiles?.find((profile) => profile.id === r.profileId)?.name;

            return {
              ...r,
              profileName,
            };
          }
          case MediaType.TV: {
            return {
              ...r,
              profileName: sonarrServers
                .find((serverr) => serverr.id === r.serverId)
                ?.profiles?.find((profile) => profile.id === r.profileId)?.name,
            };
          }
        }
      });

      // add canRemove prop if user has permission
      if (req.user?.hasPermission(Permission.MANAGE_REQUESTS)) {
        mappedRequests = mappedRequests.map((r) => {
          switch (r.type) {
            case MediaType.MOVIE: {
              return {
                ...r,
                // check if the radarr server for this request is configured
                canRemove: radarrServers.some(
                  (server) =>
                    server.id ===
                    (r.is4k ? r.media.serviceId4k : r.media.serviceId)
                ),
              };
            }
            case MediaType.TV: {
              return {
                ...r,
                // check if the sonarr server for this request is configured
                canRemove: sonarrServers.some(
                  (server) =>
                    server.id ===
                    (r.is4k ? r.media.serviceId4k : r.media.serviceId)
                ),
              };
            }
          }
        });
      }

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(requestCount / pageSize),
          pageSize,
          results: requestCount,
          page: Math.ceil(skip / pageSize) + 1,
        },
        results: mappedRequests,
        serviceErrors: {
          radarr: radarrServers
            .filter((s) => !s.profiles)
            .map((s) => ({
              id: s.id,
              name:
                settings.radarr.find((r) => r.id === s.id)?.name ||
                `Radarr ${s.id}`,
            })),
          sonarr: sonarrServers
            .filter((s) => !s.profiles)
            .map((s) => ({
              id: s.id,
              name:
                settings.sonarr.find((r) => r.id === s.id)?.name ||
                `Sonarr ${s.id}`,
            })),
        },
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

/*
 * Several titles at once, each requested only if nothing has it yet: what
 * AI Search offers to request. One at a time, as each request dispatches to
 * Radarr or Sonarr, and each through the usual request rules.
 */
const missingBody = z.object({
  items: z
    .array(
      z.object({
        tmdbId: z.number().int().positive(),
        mediaType: z.enum(['movie', 'tv']),
      })
    )
    .min(1)
    .max(REQUEST_BATCH_LIMIT),
});

requestRoutes.post('/missing', async (req, res, next) => {
  const parsed = missingBody.safeParse(req.body);
  if (!parsed.success) {
    return next({
      status: 400,
      message: `Choose up to ${REQUEST_BATCH_LIMIT} titles.`,
    });
  }
  const seen = new Set<string>();
  const results: ({ tmdbId: number; mediaType: 'movie' | 'tv' } & Awaited<
    ReturnType<typeof requestMissing>
  >)[] = [];
  for (const { tmdbId, mediaType } of parsed.data.items) {
    const key = `${mediaType}:${tmdbId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push({
      tmdbId,
      mediaType,
      ...(await requestMissing(tmdbId, mediaType, req.user as User)),
    });
  }
  return res.status(200).json({ results });
});

requestRoutes.post<never, MediaRequest, MediaRequestBody>(
  '/',
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({
          status: 401,
          message: 'You must be logged in to request media.',
        });
      }
      const request = await MediaRequest.request(
        mayChooseAdvancedOptions(req.user)
          ? req.body
          : withoutAdvancedOptions(req.body),
        req.user
      );

      return res.status(201).json(request);
    } catch (error) {
      if (!(error instanceof Error)) {
        return;
      }

      switch (error.constructor) {
        case RequestPermissionError:
        case QuotaRestrictedError:
          return next({ status: 403, message: error.message });
        case DuplicateMediaRequestError:
          return next({ status: 409, message: error.message });
        case NoSeasonsAvailableError:
          return next({ status: 202, message: error.message });
        case BlocklistedMediaError:
          return next({ status: 403, message: error.message });
        default:
          return next({ status: 500, message: error.message });
      }
    }
  }
);

/**
 * Roughly when each request should arrive, for a page of request cards in
 * one call. Registered before /:requestId, which would otherwise take "eta"
 * as an id. Each request is only estimated for someone allowed to see it.
 */
requestRoutes.get('/eta', async (req, res, next) => {
  // The validator parses "1,2,3" into a list; a plain string is handled too.
  const raw = req.query.ids as unknown;
  const ids = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 50);

  // Switched off for everyone or by this person: no estimates at all.
  if (!ids.length || !featureEnabled('arrivalEstimates', req.user)) {
    return res.status(200).json({});
  }

  try {
    const requests = await getRepository(MediaRequest).find({
      where: { id: In(ids) },
      relations: {
        media: true,
        requestedBy: true,
        seasons: { episodes: true },
      },
    });
    const seesAll = req.user?.hasPermission(
      [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
      { type: 'or' }
    );

    const visible = requests.filter(
      (request) => seesAll || request.requestedBy?.id === req.user?.id
    );
    const estimates = await Promise.all(
      visible.map(async (request) => [
        request.id,
        // The viewer's region, as their title pages show release dates.
        await estimateRequest(
          request,
          req.user?.settings?.discoverRegion || defaultRegion()
        ),
      ])
    );

    return res.status(200).json(Object.fromEntries(estimates));
  } catch (e) {
    return next({ status: 500, message: e.message });
  }
});

requestRoutes.get('/count', async (_req, res, next) => {
  const requestRepository = getRepository(MediaRequest);

  try {
    const query = requestRepository
      .createQueryBuilder('request')
      .innerJoinAndSelect('request.media', 'media');

    const totalCount = await query.getCount();

    const movieCount = await query
      .where('request.type = :requestType', {
        requestType: MediaType.MOVIE,
      })
      .getCount();

    const tvCount = await query
      .where('request.type = :requestType', {
        requestType: MediaType.TV,
      })
      .getCount();

    const pendingCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.PENDING,
      })
      .getCount();

    const approvedCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.APPROVED,
      })
      .getCount();

    const declinedCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.DECLINED,
      })
      .getCount();

    const processingCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.APPROVED,
      })
      .andWhere(
        '((request.is4k = false AND media.status != :availableStatus) OR (request.is4k = true AND media.status4k != :availableStatus))',
        {
          availableStatus: MediaStatus.AVAILABLE,
        }
      )
      .getCount();

    const availableCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.APPROVED,
      })
      .andWhere(
        '((request.is4k = false AND media.status = :availableStatus) OR (request.is4k = true AND media.status4k = :availableStatus))',
        {
          availableStatus: MediaStatus.AVAILABLE,
        }
      )
      .getCount();

    const completedCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.COMPLETED,
      })
      .getCount();

    return res.status(200).json({
      total: totalCount,
      movie: movieCount,
      tv: tvCount,
      pending: pendingCount,
      approved: approvedCount,
      declined: declinedCount,
      processing: processingCount,
      available: availableCount,
      completed: completedCount,
    });
  } catch (e) {
    logger.error('Something went wrong retrieving request counts', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 500, message: 'Unable to retrieve request counts.' });
  }
});

requestRoutes.get<{ requestId: string }>(
  '/:requestId/watch',
  isAuthenticated(),
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({ status: 401, message: 'You must be logged in.' });
      }

      const request = await getRepository(MediaRequest).findOne({
        where: { id: Number(req.params.requestId) },
      });

      if (!request) {
        return next({ status: 404, message: 'Request not found.' });
      }

      const { reachable, channels } = await getNotificationChannels(req.user);

      // The requester is notified by virtue of having made the request, so
      // their state is the mute flag rather than a watcher row.
      const isRequester = request.requestedBy?.id === req.user.id;

      if (isRequester) {
        return res.status(200).json({
          watching: !request.requesterMuted,
          isRequester: true,
          reachable,
          channels,
        });
      }

      const watcher = await getRepository(MediaRequestWatcher).findOne({
        where: {
          requestId: request.id,
          userId: req.user.id,
        },
      });

      return res.status(200).json({
        watching: !!watcher,
        isRequester: false,
        reachable,
        channels,
      });
    } catch (e) {
      logger.error('Failed to read request watch state', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to read watch state.' });
    }
  }
);

requestRoutes.post<{ requestId: string }>(
  '/:requestId/watch',
  isAuthenticated(),
  async (req, res, next) => {
    try {
      const requestRepository = getRepository(MediaRequest);
      const request = await requestRepository.findOne({
        where: { id: Number(req.params.requestId) },
        relations: { requestedBy: true },
      });

      if (!request) {
        return next({ status: 404, message: 'Request not found.' });
      }

      if (!req.user) {
        return next({ status: 401, message: 'You must be logged in.' });
      }

      // The requester is notified through the request itself, so turning
      // notifications back on means clearing the mute rather than adding a
      // watcher row.
      if (request.requestedBy.id === req.user.id) {
        if (request.requesterMuted) {
          request.requesterMuted = false;
          await requestRepository.save(request);
        }

        return res.status(200).json({ watching: true, isRequester: true });
      }

      const { reachable } = await getNotificationChannels(req.user);

      if (!reachable) {
        return next({
          status: 400,
          message:
            'You have no notification method set up. Enable notifications on this device first.',
        });
      }

      const watcherRepository = getRepository(MediaRequestWatcher);

      const existing = await watcherRepository.findOne({
        where: { requestId: request.id, userId: req.user.id },
      });

      if (!existing) {
        await watcherRepository.save(
          new MediaRequestWatcher({
            requestId: request.id,
            userId: req.user.id,
          })
        );
      }

      return res.status(200).json({ watching: true });
    } catch (e) {
      logger.error('Failed to add request watcher', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to watch request.' });
    }
  }
);

requestRoutes.delete<{ requestId: string }>(
  '/:requestId/watch',
  isAuthenticated(),
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({ status: 401, message: 'You must be logged in.' });
      }

      const request = await getRepository(MediaRequest).findOne({
        where: { id: Number(req.params.requestId) },
      });

      // Muting a request you made leaves the request itself alone — only a
      // deliberate delete removes it.
      if (request && request.requestedBy?.id === req.user?.id) {
        if (!request.requesterMuted) {
          request.requesterMuted = true;
          await getRepository(MediaRequest).save(request);
        }

        return res.status(200).json({ watching: false, isRequester: true });
      }

      await getRepository(MediaRequestWatcher).delete({
        requestId: Number(req.params.requestId),
        userId: req.user.id,
      });

      return res.status(200).json({ watching: false });
    } catch (e) {
      logger.error('Failed to remove request watcher', {
        label: 'API',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Failed to unwatch request.' });
    }
  }
);

requestRoutes.get('/:requestId', async (req, res, next) => {
  const requestRepository = getRepository(MediaRequest);

  try {
    const request = await requestRepository.findOneOrFail({
      where: { id: Number(req.params.requestId) },
      relations: { requestedBy: true, modifiedBy: true },
    });

    if (
      request.requestedBy.id !== req.user?.id &&
      !req.user?.hasPermission(
        [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
        { type: 'or' }
      )
    ) {
      return next({
        status: 403,
        message: 'You do not have permission to view this request.',
      });
    }

    return res.status(200).json(request);
  } catch (e) {
    logger.debug('Failed to retrieve request.', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 404, message: 'Request not found.' });
  }
});

requestRoutes.put<{ requestId: string }>(
  '/:requestId',
  async (req, res, next) => {
    const requestRepository = getRepository(MediaRequest);
    const userRepository = getRepository(User);
    const requestId = Number(req.params.requestId);
    try {
      // Ordering is request then owner here, user then media on create, so no cycle
      return await requestLock.dispatch(requestKey(requestId), async () => {
        const request = await requestRepository.findOne({
          where: {
            id: requestId,
          },
        });

        if (!request) {
          return next({ status: 404, message: 'Request not found.' });
        }

        // What kind of request this is comes from the request, never from
        // the body: claiming "tv" must not unlock editing a film request.
        if (
          (request.requestedBy.id !== req.user?.id ||
            (request.type !== MediaType.TV &&
              !req.user?.hasPermission(Permission.REQUEST_ADVANCED))) &&
          !req.user?.hasPermission(Permission.MANAGE_REQUESTS)
        ) {
          return next({
            status: 403,
            message: 'You do not have permission to modify this request.',
          });
        }
        req.body.mediaType = request.type;

        // Someone changing only their seasons keeps the server, profile,
        // folder and tags the request already has.
        if (!mayChooseAdvancedOptions(req.user)) {
          req.body.serverId = request.serverId;
          req.body.profileId = request.profileId;
          req.body.rootFolder = request.rootFolder;
          req.body.languageProfileId = request.languageProfileId;
          req.body.tags = request.tags;
        }

        if (request.status !== MediaRequestStatus.PENDING) {
          return next({
            status: 409,
            message: 'Only pending requests can be modified.',
          });
        }

        const previousOwnerId = request.requestedBy.id;
        let requestUser = request.requestedBy;

        if (
          req.body.userId &&
          req.body.userId !== request.requestedBy.id &&
          !req.user?.hasPermission([
            Permission.MANAGE_USERS,
            Permission.MANAGE_REQUESTS,
          ])
        ) {
          return next({
            status: 403,
            message: 'You do not have permission to modify the request user.',
          });
        } else if (req.body.userId) {
          requestUser = await userRepository.findOneOrFail({
            where: { id: req.body.userId },
          });
        }

        // Reassignment moves every season on the request onto the new owner's
        // quota, so it is charged in full rather than as a delta
        const ownerChanging = requestUser.id !== previousOwnerId;

        // Anime or not as ticked in the request dialog; left out, the
        // request keeps what it had, and null hands it back to the title's
        // setting and detection.
        const setChosenSeriesType = () => {
          if (req.body.seriesType !== undefined) {
            request.seriesType = toSeriesTypeFor(
              request.type,
              req.body.seriesType
            );
          }
        };

        return requestLock.dispatch(userKey(requestUser.id), async () => {
          if (req.body.mediaType === MediaType.MOVIE) {
            if (ownerChanging && !request.ignoreQuota) {
              const quotas = await requestUser.getQuota();

              if (quotas.movie.restricted) {
                return next({
                  status: 403,
                  message: 'Movie Quota exceeded.',
                });
              }
            }

            request.serverId = req.body.serverId;
            request.profileId = req.body.profileId;
            request.rootFolder = req.body.rootFolder;
            request.tags = req.body.tags;
            setChosenSeriesType();
            request.requestedBy = requestUser as User;

            await requestRepository.save(request);
          } else if (req.body.mediaType === MediaType.TV) {
            const mediaRepository = getRepository(Media);
            request.serverId = req.body.serverId;
            request.profileId = req.body.profileId;
            request.rootFolder = req.body.rootFolder;
            request.languageProfileId = req.body.languageProfileId;
            request.tags = req.body.tags;
            setChosenSeriesType();
            request.requestedBy = requestUser as User;

            const requestedSeasons = req.body.seasons as number[] | undefined;

            if (!requestedSeasons || requestedSeasons.length === 0) {
              throw new Error(
                'Missing seasons. If you want to cancel a series request, use the DELETE method.'
              );
            }

            // Same key as create, so an edit cannot claim a season that a new
            // request is taking at the same moment
            return mediaLock.dispatch(
              mediaKey(MediaType.TV, request.media.tmdbId),
              async () => {
                // Get existing media so we can work with all the requests
                const media = await mediaRepository.findOneOrFail({
                  where: {
                    tmdbId: request.media.tmdbId,
                    mediaType: MediaType.TV,
                  },
                  relations: { requests: true },
                });

                // Get all requested seasons that are not part of this request we are editing
                const existingSeasons = media.requests
                  .filter(
                    (r) =>
                      r.is4k === request.is4k &&
                      r.id !== request.id &&
                      r.status !== MediaRequestStatus.DECLINED &&
                      r.status !== MediaRequestStatus.COMPLETED
                  )
                  .reduce((seasons, r) => {
                    const combinedSeasons = r.seasons.map(
                      (season) => season.seasonNumber
                    );

                    return [...seasons, ...combinedSeasons];
                  }, [] as number[]);

                const currentSeasons = request.seasons.map(
                  (s) => s.seasonNumber
                );

                // Seasons the media already covers cannot be requested again, while
                // the ones this request holds stay on it
                const coveredSeasons = (media.seasons ?? [])
                  .filter(
                    (season) =>
                      season[request.is4k ? 'status4k' : 'status'] !==
                        MediaStatus.UNKNOWN &&
                      season[request.is4k ? 'status4k' : 'status'] !==
                        MediaStatus.DELETED
                  )
                  .map((season) => season.seasonNumber)
                  .filter((sn) => !currentSeasons.includes(sn));

                const filteredSeasons = requestedSeasons.filter(
                  (rs) => !existingSeasons.includes(rs)
                );

                const keptSeasons = filteredSeasons.filter((sn) =>
                  currentSeasons.includes(sn)
                );

                const newSeasons = filteredSeasons.filter(
                  (sn) =>
                    !currentSeasons.includes(sn) && !coveredSeasons.includes(sn)
                );

                const resultingSeasonCount =
                  keptSeasons.length + newSeasons.length;

                if (resultingSeasonCount === 0) {
                  return next({
                    status: 202,
                    message: 'No seasons available to request',
                  });
                }

                if (!request.ignoreQuota) {
                  const quotas = await requestUser.getQuota();

                  // Only the seasons getQuota already counted for this owner are
                  // paid for, so the edit is charged for everything it left out
                  const quotaWindowStart = new Date();
                  if (quotas.tv.days) {
                    quotaWindowStart.setDate(
                      quotaWindowStart.getDate() - quotas.tv.days
                    );
                  }

                  const countedAlready =
                    !ownerChanging &&
                    (!quotas.tv.days || request.createdAt > quotaWindowStart);

                  const priorSeasonCount = countedAlready
                    ? request.seasons.length
                    : 0;
                  const requiredSeasons =
                    resultingSeasonCount - priorSeasonCount;

                  if (
                    quotas.tv.limit &&
                    requiredSeasons > (quotas.tv.remaining ?? 0)
                  ) {
                    return next({
                      status: 403,
                      message: 'Series Quota exceeded.',
                    });
                  }
                }

                request.seasons = request.seasons.filter((rs) =>
                  keptSeasons.includes(rs.seasonNumber)
                );

                if (newSeasons.length > 0) {
                  logger.debug('Adding new seasons to request', {
                    label: 'Media Request',
                    newSeasons,
                  });
                  request.seasons.push(
                    ...newSeasons.map(
                      (ns) =>
                        new SeasonRequest({
                          seasonNumber: ns,
                          status: MediaRequestStatus.PENDING,
                        })
                    )
                  );
                }

                await requestRepository.save(request);

                return res.status(200).json(request);
              }
            );
          }

          return res.status(200).json(request);
        });
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

requestRoutes.delete('/:requestId', async (req, res, next) => {
  const requestRepository = getRepository(MediaRequest);
  const requestId = Number(req.params.requestId);

  try {
    return await requestLock.dispatch(requestKey(requestId), async () => {
      const request = await requestRepository.findOneOrFail({
        where: { id: requestId },
        relations: { requestedBy: true, modifiedBy: true },
      });

      if (
        !req.user?.hasPermission(Permission.MANAGE_REQUESTS) &&
        (request.requestedBy.id !== req.user?.id ||
          request.status !== MediaRequestStatus.PENDING)
      ) {
        return next({
          status: 401,
          message: 'You do not have permission to delete this request.',
        });
      }

      await requestRepository.remove(request);

      return res.status(204).send();
    });
  } catch (e) {
    logger.error('Something went wrong deleting a request.', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 404, message: 'Request not found.' });
  }
});

requestRoutes.post<{
  requestId: string;
}>(
  '/:requestId/retry',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const requestRepository = getRepository(MediaRequest);
    const requestId = Number(req.params.requestId);

    try {
      return await requestLock.dispatch(requestKey(requestId), async () => {
        const request = await requestRepository.findOneOrFail({
          where: { id: requestId },
          relations: { requestedBy: true, modifiedBy: true },
        });

        if (request.status !== MediaRequestStatus.FAILED) {
          return next({
            status: 409,
            message: 'Only failed requests can be retried.',
          });
        }

        // this also triggers updating the parent media's status & sending to *arr
        request.status = MediaRequestStatus.APPROVED;
        request.modifiedBy = req.user;
        await requestRepository.save(request);

        return res.status(200).json(request);
      });
    } catch (e) {
      logger.error('Error processing request retry', {
        label: 'Media Request',
        message: e.message,
      });
      next({ status: 404, message: 'Request not found.' });
    }
  }
);

requestRoutes.post<{
  requestId: string;
  status: 'approve' | 'decline';
}>(
  '/:requestId/:status',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const requestRepository = getRepository(MediaRequest);
    const requestId = Number(req.params.requestId);

    try {
      return await requestLock.dispatch(requestKey(requestId), async () => {
        const request = await requestRepository.findOneOrFail({
          where: { id: requestId },
          relations: { requestedBy: true, modifiedBy: true },
        });

        let newStatus: MediaRequestStatus;

        switch (req.params.status) {
          case 'approve':
            newStatus = MediaRequestStatus.APPROVED;
            break;
          case 'decline':
            newStatus = MediaRequestStatus.DECLINED;
            break;
          default:
            return next({
              status: 400,
              message: 'Status must be approve or decline.',
            });
        }

        if (request.status !== MediaRequestStatus.PENDING) {
          return next({
            status: 409,
            message: 'Only pending requests can be approved or declined.',
          });
        }

        request.status = newStatus;
        request.modifiedBy = req.user;
        await requestRepository.save(request);

        return res.status(200).json(request);
      });
    } catch (e) {
      logger.error('Error processing request update', {
        label: 'Media Request',
        message: e.message,
      });
      next({ status: 404, message: 'Request not found.' });
    }
  }
);

export default requestRoutes;
