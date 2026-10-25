import { MusicBrainzBusyError } from '@server/api/musicbrainz';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { REQUEST_BATCH_LIMIT } from '@server/constants/lists';
import {
  DECLINE_REASON_MAX_LENGTH,
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  VIDEO_MEDIA_TYPES,
} from '@server/constants/media';
import { toSeriesTypeFor } from '@server/constants/seriesType';
import { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import Media from '@server/entity/Media';
import {
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  InvalidMusicRequestError,
  MediaRequest,
  NoAlbumsAvailableError,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import { MediaRequestWatcher } from '@server/entity/MediaRequestWatcher';
import MusicAlbum from '@server/entity/MusicAlbum';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User, countsTowardsQuota } from '@server/entity/User';
import type {
  MediaRequestBody,
  MusicRequestBody,
  RequestResultsResponse,
} from '@server/interfaces/api/requestInterfaces';
import { featureEnabled } from '@server/lib/features';
import { musicReady } from '@server/lib/music/access';
import { attachAlbumStatuses } from '@server/lib/music/albumStatuses';
import {
  NotTheArtistsAlbumError,
  resolveRequestAlbums,
} from '@server/lib/music/requestAlbums';
import {
  NotTheArtistsSongError,
  UnrequestableSongError,
} from '@server/lib/music/requestSongs';
import { getNotificationChannels } from '@server/lib/notificationChannels';
import { releaseDelivery } from '@server/lib/notificationDelivery';
import { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { defaultRegion, estimateRequest } from '@server/lib/requestEta';
import { requestMissing } from '@server/lib/requestMissing';
import {
  defaultServerFor,
  hasServersFor,
  requestServerIssue,
  serverExists,
  serviceName,
} from '@server/lib/requestServers';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import {
  MUSIC_NOT_SET_UP,
  MUSIC_OFF,
  requireMusic,
} from '@server/middleware/music';
import { pageOf } from '@server/utils/pagination';
import requestLock, {
  mediaKey,
  mediaLock,
  requestKey,
  userKey,
} from '@server/utils/requestLock';
import { Router } from 'express';
import type { WhereExpressionBuilder } from 'typeorm';
import { Brackets, In, Not } from 'typeorm';
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

/*
 * A blocklisted title must stay out of Radarr and Sonarr. Approving or
 * retrying a request made before it was blocklisted would send it there
 * anyway, so both are refused; declining or deleting it is still allowed.
 */
const titleBlocklisted = (request: MediaRequest) =>
  request.media?.status === MediaStatus.BLOCKLISTED ||
  request.media?.status4k === MediaStatus.BLOCKLISTED;

const withoutAdvancedOptions = (body: MediaRequestBody): MediaRequestBody => {
  const allowed = { ...body };
  delete allowed.serverId;
  delete allowed.profileId;
  delete allowed.rootFolder;
  delete allowed.languageProfileId;
  delete allowed.tags;
  return allowed;
};

const musicWithoutAdvancedOptions = (
  body: MusicRequestBody
): MusicRequestBody => {
  const allowed = { ...body };
  delete allowed.serverId;
  delete allowed.profileId;
  delete allowed.metadataProfileId;
  delete allowed.rootFolder;
  delete allowed.tags;
  return allowed;
};

/** Music is listed and handled for this person: set up, and on for them. */
const musicFor = (user?: User) => musicReady() && featureEnabled('music', user);

/** The kinds of request listed and counted for this person. */
const requestTypesFor = (user?: User): MediaType[] =>
  musicFor(user)
    ? [...VIDEO_MEDIA_TYPES, MediaType.MUSIC]
    : [...VIDEO_MEDIA_TYPES];

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

      // Music only for someone who has it: set up, and not turned off.
      const listedTypes = requestTypesFor(req.user);
      const mediaTypes = splitParam(req.query.mediaType).filter(
        (type): type is MediaType => listedTypes.includes(type as MediaType)
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
        .leftJoinAndSelect('request.albums', 'albums')
        .leftJoinAndSelect('request.songs', 'songs')
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

      // Ticking none is everything this person can see.
      query = query.andWhere('request.type IN (:...mediaTypes)', {
        mediaTypes: mediaTypes.length ? mediaTypes : listedTypes,
      });

      const [requests, requestCount] = await query
        .orderBy(sortFilter, sortDirection)
        .addOrderBy('request.id', sortDirection)
        .take(pageSize)
        .skip(skip)
        .getManyAndCount();

      await attachAlbumStatuses(requests);

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
          default:
            return { ...r, profileName: undefined };
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
            default:
              return { ...r, canRemove: false };
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
      // With partial requests off, every request is for whole seasons, so
      // any single episodes asked for are left out.
      if (!getSettings().main.partialRequestsEnabled) {
        delete req.body.episodes;
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

/*
 * Albums of one artist, sent to Lidarr once approved. Its own route: a
 * music request names an artist and albums by MusicBrainz id, not a TMDB
 * title.
 */
requestRoutes.post<never, MediaRequest, MusicRequestBody>(
  '/music',
  requireMusic,
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({
          status: 401,
          message: 'You must be logged in to request media.',
        });
      }
      const request = await MediaRequest.requestMusic(
        mayChooseAdvancedOptions(req.user)
          ? req.body
          : musicWithoutAdvancedOptions(req.body),
        req.user
      );

      return res.status(201).json(request);
    } catch (error) {
      return next(musicRequestError(error));
    }
  }
);

/** What a music request's failure means for the person making it. */
const musicRequestError = (
  error: unknown
): { status: number; message: string } => {
  if (!(error instanceof Error)) {
    return { status: 500, message: 'Something went wrong.' };
  }
  switch (error.constructor) {
    case RequestPermissionError:
    case QuotaRestrictedError:
    case BlocklistedMediaError:
      return { status: 403, message: error.message };
    case DuplicateMediaRequestError:
    case NoAlbumsAvailableError:
      return { status: 409, message: error.message };
    case InvalidMusicRequestError:
    case NotTheArtistsAlbumError:
    case NotTheArtistsSongError:
    case UnrequestableSongError:
      return { status: 400, message: error.message };
    case MusicBrainzBusyError:
      return { status: 503, message: error.message };
    default:
      logger.error('Could not make a music request', {
        label: 'Media Request',
        errorMessage: error.message,
      });
      return { status: 500, message: error.message };
  }
};

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

requestRoutes.get('/count', async (req, res, next) => {
  const requestRepository = getRepository(MediaRequest);

  try {
    // Only the kinds of request this person is shown in the list: music
    // only where it is set up and on for them, so the pending badge never
    // counts requests they cannot open.
    const countedTypes = requestTypesFor(req.user);
    const query = () =>
      requestRepository
        .createQueryBuilder('request')
        .innerJoinAndSelect('request.media', 'media')
        .where('request.type IN (:...countedTypes)', { countedTypes });

    const totalCount = await query().getCount();

    const movieCount = await query()
      .andWhere('request.type = :requestType', {
        requestType: MediaType.MOVIE,
      })
      .getCount();

    const tvCount = await query()
      .andWhere('request.type = :requestType', {
        requestType: MediaType.TV,
      })
      .getCount();

    const musicCount = await query()
      .andWhere('request.type = :requestType', {
        requestType: MediaType.MUSIC,
      })
      .getCount();

    const pendingCount = await query()
      .andWhere('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.PENDING,
      })
      .getCount();

    const approvedCount = await query()
      .andWhere('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.APPROVED,
      })
      .getCount();

    const declinedCount = await query()
      .andWhere('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.DECLINED,
      })
      .getCount();

    const processingCount = await query()
      .andWhere('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.APPROVED,
      })
      .andWhere(
        '((request.is4k = false AND media.status != :availableStatus) OR (request.is4k = true AND media.status4k != :availableStatus))',
        {
          availableStatus: MediaStatus.AVAILABLE,
        }
      )
      .getCount();

    const availableCount = await query()
      .andWhere('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.APPROVED,
      })
      .andWhere(
        '((request.is4k = false AND media.status = :availableStatus) OR (request.is4k = true AND media.status4k = :availableStatus))',
        {
          availableStatus: MediaStatus.AVAILABLE,
        }
      )
      .getCount();

    const completedCount = await query()
      .andWhere('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.COMPLETED,
      })
      .getCount();

    return res.status(200).json({
      total: totalCount,
      movie: movieCount,
      tv: tvCount,
      music: musicCount,
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
        // Only the flag is written. Saving the whole request ran its save
        // hooks, which announced an approved or declined request all over
        // again and sent an approved one to Radarr or Sonarr a second time.
        if (request.requesterMuted) {
          await requestRepository.update(request.id, {
            requesterMuted: false,
          });
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
        // Only the flag is written, as when turning notifications back on.
        if (!request.requesterMuted) {
          await getRepository(MediaRequest).update(request.id, {
            requesterMuted: true,
          });
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

    await attachAlbumStatuses([request]);

    return res.status(200).json(request);
  } catch (e) {
    logger.debug('Failed to retrieve request.', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 404, message: 'Request not found.' });
  }
});

/**
 * Changes a pending music request: its albums, and the server, profiles,
 * folder and tags it goes to Lidarr with (what the body carries, already
 * limited to what the person may change). Albums are added or taken off
 * as rows of their own, and the request itself is only updated, so saving
 * it cannot send it anywhere.
 */
const editMusicRequest = async (
  request: MediaRequest,
  body: MediaRequestBody & { albums?: string[]; metadataProfileId?: number },
  requestUser: User,
  ownerChanging: boolean
): Promise<
  { request: MediaRequest } | { error: { status: number; message: string } }
> => {
  const albumRepository = getRepository(MusicAlbum);
  const albumRequestRepository = getRepository(AlbumRequest);
  const media = request.media;
  const current = request.albums ?? [];
  const asked = [...new Set(body.albums ?? current.map((a) => a.albumMbid))];

  // A request for songs may hold no albums; their songs are kept as they are.
  const songs = request.songs ?? [];
  if (!asked.length && !songs.length) {
    return {
      error: {
        status: 400,
        message:
          'Choose at least one album. To take back the whole request, delete it.',
      },
    };
  }
  const maxAlbums = getSettings().music.maxAlbumsPerRequest;
  if (maxAlbums > 0 && asked.length > maxAlbums) {
    return {
      error: {
        status: 400,
        message: `One request can ask for at most ${maxAlbums} albums.`,
      },
    };
  }

  // Albums another open request holds, or already here, cannot be added.
  const others = await getRepository(MediaRequest).find({
    where: {
      media: { id: media.id },
      id: Not(request.id),
      status: Not(
        In([MediaRequestStatus.DECLINED, MediaRequestStatus.COMPLETED])
      ),
    },
  });
  const knownAlbums = await albumRepository.find({
    where: { mediaId: media.id },
  });
  const currentIds = current.map((album) => album.albumMbid);
  const taken = new Set([
    ...others.flatMap((other) => other.albums.map((a) => a.albumMbid)),
    ...knownAlbums
      .filter(
        (album) =>
          album.mbId &&
          !currentIds.includes(album.mbId) &&
          album.status !== MediaStatus.UNKNOWN &&
          album.status !== MediaStatus.DELETED
      )
      .map((album) => album.mbId as string),
  ]);
  const kept = current.filter((album) => asked.includes(album.albumMbid));
  const added = asked.filter(
    (id) => !currentIds.includes(id) && !taken.has(id)
  );
  const dropped = current.filter((album) => !asked.includes(album.albumMbid));

  if (!kept.length && !added.length && !songs.length) {
    return {
      error: {
        status: 409,
        message: 'Every album asked for is already here or already requested.',
      },
    };
  }

  if (!request.ignoreQuota) {
    const quotas = await requestUser.getQuota();
    // Albums the owner's quota already counted for this request are paid
    // for; a new owner is charged for all of them.
    const countedAlready =
      !ownerChanging &&
      countsTowardsQuota(request.createdAt, quotas.music.days);
    const required =
      kept.length + added.length - (countedAlready ? current.length : 0);
    if (quotas.music.limit && required > (quotas.music.remaining ?? 0)) {
      return { error: { status: 403, message: 'Music Quota exceeded.' } };
    }
  }

  let resolved: Awaited<ReturnType<typeof resolveRequestAlbums>> | undefined;
  if (added.length) {
    try {
      resolved = await resolveRequestAlbums(
        media.foreignId ?? '',
        added,
        knownAlbums
      );
    } catch (e) {
      return { error: musicRequestError(e) };
    }
  }

  if (dropped.length) {
    await albumRequestRepository.delete(dropped.map((album) => album.id));
    // An album nobody else is waiting for is no longer pending.
    const stillWanted = new Set(
      others.flatMap((other) => other.albums.map((a) => a.albumMbid))
    );
    for (const album of dropped) {
      const row = knownAlbums.find((known) => known.mbId === album.albumMbid);
      if (
        row &&
        row.status === MediaStatus.PENDING &&
        !stillWanted.has(album.albumMbid)
      ) {
        await albumRepository.update(row.id, { status: MediaStatus.UNKNOWN });
      }
    }
  }

  for (const album of resolved?.albums ?? []) {
    const row = knownAlbums.find((known) => known.mbId === album.mbId);
    if (!row) {
      await albumRepository.insert(
        new MusicAlbum({
          mediaId: media.id,
          mbId: album.mbId,
          title: album.title,
          primaryType: album.primaryType ?? null,
          secondaryTypes: album.secondaryTypes,
          releaseDate: album.releaseDate ?? null,
          status: MediaStatus.PENDING,
        })
      );
    } else if (
      row.status === MediaStatus.UNKNOWN ||
      row.status === MediaStatus.DELETED
    ) {
      await albumRepository.update(row.id, { status: MediaStatus.PENDING });
    }
    await albumRequestRepository.insert(
      new AlbumRequest({
        request: { id: request.id } as MediaRequest,
        albumMbid: album.mbId,
        title: album.title,
        status: MediaRequestStatus.PENDING,
      })
    );
  }

  await getRepository(MediaRequest).update(request.id, {
    serverId: body.serverId,
    profileId: body.profileId,
    metadataProfileId: body.metadataProfileId ?? null,
    rootFolder: body.rootFolder,
    tags: body.tags,
    requestedBy: { id: requestUser.id },
  });

  const updated = await getRepository(MediaRequest).findOneOrFail({
    where: { id: request.id },
    relations: { requestedBy: true, modifiedBy: true },
  });
  await attachAlbumStatuses([updated]);
  return { request: updated };
};

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
        // Whoever made a series or music request may change its seasons or
        // albums; a film request has only the advanced options to change.
        if (
          (request.requestedBy.id !== req.user?.id ||
            (request.type === MediaType.MOVIE &&
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
          req.body.metadataProfileId = request.metadataProfileId;
          req.body.tags = request.tags;
        }

        // A failed request can be put right by a request manager (another
        // server, say, when its own was removed) before it is retried.
        if (
          request.status !== MediaRequestStatus.PENDING &&
          !(
            request.status === MediaRequestStatus.FAILED &&
            req.user?.hasPermission(Permission.MANAGE_REQUESTS)
          )
        ) {
          return next({
            status: 409,
            message:
              'Only pending requests can be modified, and failed ones by a request manager.',
          });
        }

        // A server it does not already have must exist. The one it has is
        // kept even if it was removed, so changing seasons still works;
        // Retry then sends it to the default server. With no server of its
        // kind at all (requests fulfilled by hand), the id means nothing
        // and is kept as given, as before.
        if (
          req.body.serverId !== undefined &&
          req.body.serverId !== null &&
          req.body.serverId >= 0 &&
          req.body.serverId !== request.serverId &&
          hasServersFor(request.type) &&
          !serverExists(request.type, req.body.serverId)
        ) {
          return next({
            status: 400,
            message: 'That server no longer exists. Choose another.',
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

        if (request.type === MediaType.MUSIC) {
          if (!featureEnabled('music', req.user)) {
            return next(MUSIC_OFF);
          }
          if (!musicReady()) {
            return next(MUSIC_NOT_SET_UP);
          }
          return requestLock.dispatch(userKey(requestUser.id), () =>
            mediaLock.dispatch(
              mediaKey(MediaType.MUSIC, request.media.foreignId ?? ''),
              async () => {
                const edited = await editMusicRequest(
                  request,
                  req.body,
                  requestUser,
                  ownerChanging
                );
                return 'error' in edited
                  ? next(edited.error)
                  : res.status(200).json(edited.request);
              }
            )
          );
        }

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
            request.noteServerIssue();
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
                  const countedAlready =
                    !ownerChanging &&
                    countsTowardsQuota(request.createdAt, quotas.tv.days);

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
                request.noteServerIssue();

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

        if (titleBlocklisted(request)) {
          return next({
            status: 409,
            message: 'This title is blocklisted, so it cannot be retried.',
          });
        }

        // Its server was removed, or none is the default: the default server
        // of its kind takes it, starting from that server's own profile, folder and
        // tags (the old server's mean nothing there). With no default, a
        // manager has to choose one, and retrying would only fail again.
        const serverIssue = requestServerIssue(request);
        if (serverIssue) {
          const name = serviceName(serverIssue.service, request.is4k);
          const fallback = serverIssue.usesDefault
            ? defaultServerFor(request)
            : undefined;
          if (!fallback) {
            return res.status(409).json({
              message:
                serverIssue.reason === 'none'
                  ? `No ${name} server is set up. Add one in Settings → Services, then retry.`
                  : `This request has no ${name} server to go to. Edit it to choose one, then retry.`,
              code: serverIssue.reason === 'none' ? 'noServer' : 'chooseServer',
              serverIssue,
            });
          }
          const note = `Sent to the default ${name} server, ${fallback.name}, as its own server was removed.`;
          logger.info(note, {
            label: 'Media Request',
            requestId: request.id,
            removedServerId: request.serverId,
            serverId: fallback.id,
          });
          Object.assign(request, {
            serverId: fallback.id,
            profileId: null,
            rootFolder: null,
            languageProfileId: null,
            metadataProfileId: null,
            tags: null,
          });
          request.historyNote = note;
        }

        // The failure was reported once; without letting go of that, a
        // second failure after this retry would never be reported at all.
        await releaseDelivery(request.id, Notification.MEDIA_FAILED);

        // this also triggers updating the parent media's status & sending to *arr
        request.status = MediaRequestStatus.APPROVED;
        request.modifiedBy = req.user;
        await requestRepository.save(request);
        delete request.historyNote;
        request.noteServerIssue();

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

/*
 * Whoever declines a request may say why. Blank after trimming is no reason
 * at all. The Decline button on a push notification sends no body, so it
 * declines without one.
 */
const statusChangeBody = z
  .object({
    declineReason: z
      .string()
      .trim()
      .max(
        DECLINE_REASON_MAX_LENGTH,
        `A reason can be at most ${DECLINE_REASON_MAX_LENGTH} characters.`
      )
      .nullish(),
  })
  .optional();

requestRoutes.post<{
  requestId: string;
  status: 'approve' | 'decline';
}>(
  '/:requestId/:status',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const requestRepository = getRepository(MediaRequest);
    const requestId = Number(req.params.requestId);

    const body = statusChangeBody.safeParse(req.body);

    if (!body.success) {
      return next({ status: 400, message: body.error.issues[0]?.message });
    }

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

        if (
          newStatus === MediaRequestStatus.APPROVED &&
          titleBlocklisted(request)
        ) {
          return next({
            status: 409,
            message: 'This title is blocklisted, so it cannot be approved.',
          });
        }

        request.status = newStatus;
        request.modifiedBy = req.user;
        // Saved with the status, so the declined notification and the
        // title's history both have it.
        if (newStatus === MediaRequestStatus.DECLINED) {
          request.declineReason = body.data?.declineReason || null;
        }
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
