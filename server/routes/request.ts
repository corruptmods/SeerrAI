import { MusicBrainzBusyError } from '@server/api/musicbrainz';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
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
import {
  playlistRequestGroups,
  withoutPlaylistRequests,
} from '@server/lib/playlists/requestGroups';
import { defaultRegion, estimateRequest } from '@server/lib/requestEta';
import { requestMissing } from '@server/lib/requestMissing';
import {
  CHOSEN_SERVER_MESSAGES,
  chosenServerProblem,
  defaultServerFor,
  requestServerIssue,
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
 * Advanced options (server, quality profile, root folder, language profile,
 * tags) are only for those allowed them; everyone else gets the defaults.
 */
const mayChooseAdvancedOptions = (user?: User) =>
  !!user?.hasPermission(
    [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
    { type: 'or' }
  );

/*
 * A blocklisted title must stay out of Radarr and Sonarr, so approving or
 * retrying an older request for it is refused; declining or deleting is still
 * allowed.
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

/** Whether music is set up and on for this person. */
const musicFor = (user?: User) => musicReady() && featureEnabled('music', user);

/** Request types listed and counted for this person. */
const requestTypesFor = (user?: User): MediaType[] =>
  musicFor(user)
    ? [...VIDEO_MEDIA_TYPES, MediaType.MUSIC]
    : [...VIDEO_MEDIA_TYPES];

/** TMDB search pages read per request search. */
const SEARCH_PAGES = 2;

/**
 * Request ids matching a search: films and series via TMDB search (titles
 * aren't stored on requests), music by stored artist, album or song. If TMDB
 * fails, only music is matched.
 */
const searchedRequests = async (
  text: string,
  types: MediaType[]
): Promise<{ movies: number[]; series: number[]; music: number[] }> => {
  const found = {
    movies: [] as number[],
    series: [] as number[],
    music: [] as number[],
  };
  if (types.some((type) => type === MediaType.MOVIE || type === MediaType.TV)) {
    const tmdb = new TheMovieDb();
    for (let page = 1; page <= SEARCH_PAGES; page++) {
      const answer = await tmdb
        .searchMulti({ query: text, page })
        .catch((e: unknown) => {
          logger.debug('TMDB could not be searched for requests', {
            label: 'Media Request',
            errorMessage: e instanceof Error ? e.message : String(e),
          });
          return undefined;
        });
      for (const result of answer?.results ?? []) {
        if (result.media_type === 'movie') found.movies.push(result.id);
        if (result.media_type === 'tv') found.series.push(result.id);
      }
      if (!answer || page >= (answer.total_pages ?? 1)) break;
    }
  }
  // Strip LIKE wildcards.
  const words = text
    .toLowerCase()
    .replace(/[%_\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (types.includes(MediaType.MUSIC) && words) {
    const like = `%${words}%`;
    const rows = await getRepository(MediaRequest)
      .createQueryBuilder('request')
      .leftJoin('request.media', 'media')
      .leftJoin('request.albums', 'albums')
      .leftJoin('request.songs', 'songs')
      .select('request.id', 'id')
      .distinct(true)
      .where('request.type = :music', { music: MediaType.MUSIC })
      .andWhere(
        new Brackets((match) =>
          match
            .where('LOWER(media.foreignTitle) LIKE :like', { like })
            .orWhere('LOWER(albums.title) LIKE :like', { like })
            .orWhere('LOWER(songs.title) LIKE :like', { like })
        )
      )
      .limit(5000)
      .getRawMany<{ id: number }>();
    found.music = rows.map((row) => Number(row.id));
  }
  return found;
};

requestRoutes.get<Record<string, unknown>, RequestResultsResponse>(
  '/',
  async (req, res, next) => {
    try {
      const { pageSize, skip } = pageOf(req.query, 10);
      // Each filter accepts a comma-separated list.
      const splitParam = (value: unknown): string[] =>
        String(value ?? '')
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);

      const requestedByIds = splitParam(req.query.requestedBy)
        .map(Number)
        .filter((id) => Number.isFinite(id));

      const listedTypes = requestTypesFor(req.user);
      const mediaTypes = splitParam(req.query.mediaType).filter(
        (type): type is MediaType => listedTypes.includes(type as MediaType)
      );

      /**
       * Each filter pairs a request status with media statuses, so they can't
       * be merged into two flat lists: "available" + "failed" must mean
       * (completed AND available) OR (failed AND any), not (completed OR
       * failed) AND (available OR any), which lets failed-but-available
       * through.
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

      // No filter ticked: everything this person can see.
      query = query.andWhere('request.type IN (:...mediaTypes)', {
        mediaTypes: mediaTypes.length ? mediaTypes : listedTypes,
      });

      const search = String(req.query.search ?? '')
        .trim()
        .slice(0, 100);
      if (search) {
        const found = await searchedRequests(
          search,
          mediaTypes.length ? mediaTypes : listedTypes
        );
        query = query.andWhere(
          new Brackets((match) => {
            match.where('1 = 0');
            if (found.movies.length) {
              match.orWhere(
                '(request.type = :movie AND media.tmdbId IN (:...searchedMovies))',
                { movie: MediaType.MOVIE, searchedMovies: found.movies }
              );
            }
            if (found.series.length) {
              match.orWhere(
                '(request.type = :tv AND media.tmdbId IN (:...searchedSeries))',
                { tv: MediaType.TV, searchedSeries: found.series }
              );
            }
            if (found.music.length) {
              match.orWhere('request.id IN (:...searchedMusic)', {
                searchedMusic: found.music,
              });
            }
          })
        );
      }

      // Group each playlist import's requests into one entry.
      const playlists =
        req.query.playlists === 'group' && req.user
          ? await playlistRequestGroups(query, req.user, pageSize)
          : undefined;
      if (playlists) {
        query = withoutPlaylistRequests(query);
      }

      const [requests, requestCount] = await query
        .orderBy(sortFilter, sortDirection)
        .addOrderBy('request.id', sortDirection)
        .take(pageSize)
        .skip(skip)
        .getManyAndCount();

      await attachAlbumStatuses(requests);

      const settings = getSettings();

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

      let mappedRequests = requests.map((r) => {
        switch (r.type) {
          case MediaType.MOVIE:
            return {
              ...r,
              profileName: radarrServers
                .find((server) => server.id === r.serverId)
                ?.profiles?.find((profile) => profile.id === r.profileId)?.name,
            };
          case MediaType.TV:
            return {
              ...r,
              profileName: sonarrServers
                .find((server) => server.id === r.serverId)
                ?.profiles?.find((profile) => profile.id === r.profileId)?.name,
            };
          default:
            return { ...r, profileName: undefined };
        }
      });

      if (req.user?.hasPermission(Permission.MANAGE_REQUESTS)) {
        mappedRequests = mappedRequests.map((r) => {
          switch (r.type) {
            case MediaType.MOVIE: {
              return {
                ...r,
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
        ...(playlists ? { playlists } : {}),
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
 * Request several titles, each only if nothing has it yet (AI Search).
 * Sequential, since each dispatches to Radarr or Sonarr, and each goes through
 * the usual request rules.
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
      // With partial requests off, single episodes are dropped.
      if (!getSettings().main.partialRequestsEnabled) {
        delete req.body.episodes;
      }
      const advanced = mayChooseAdvancedOptions(req.user);
      const serverProblem = advanced
        ? chosenServerProblem({
            type: req.body.mediaType,
            serverId: req.body.serverId,
            is4k: req.body.is4k,
          })
        : undefined;
      if (serverProblem) {
        return next({
          status: 400,
          message: CHOSEN_SERVER_MESSAGES[serverProblem],
        });
      }
      const request = await MediaRequest.request(
        advanced ? req.body : withoutAdvancedOptions(req.body),
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
 * Request an artist's albums (sent to Lidarr once approved). Separate route
 * because music is keyed by MusicBrainz id, not TMDB.
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
      const advanced = mayChooseAdvancedOptions(req.user);
      const serverProblem = advanced
        ? chosenServerProblem({
            type: MediaType.MUSIC,
            serverId: req.body.serverId,
          })
        : undefined;
      if (serverProblem) {
        return next({
          status: 400,
          message: CHOSEN_SERVER_MESSAGES[serverProblem],
        });
      }
      const request = await MediaRequest.requestMusic(
        advanced ? req.body : musicWithoutAdvancedOptions(req.body),
        req.user
      );

      return res.status(201).json(request);
    } catch (error) {
      return next(musicRequestError(error));
    }
  }
);

/** User-facing meaning of a music request failure. */
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
 * Arrival estimates for a page of request cards. Registered before /:requestId,
 * which would take "eta" as an id. Only requests the viewer may see are
 * estimated.
 */
requestRoutes.get('/eta', async (req, res, next) => {
  // The validator parses "1,2,3" into a list; a plain string is handled too.
  const raw = req.query.ids as unknown;
  const ids = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 50);

  // Off globally or for this person: no estimates.
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
        // Viewer's region, as their title pages use for release dates.
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
    // Count only types this person sees in the list, so the pending badge never
    // counts requests they can't open.
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

      // The requester is notified via the request itself, so their state is the
      // mute flag, not a watcher row.
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

      // The requester's notifications are the mute flag, not a watcher row.
      if (request.requestedBy.id === req.user.id) {
        // Write only the flag: saving the whole request runs save hooks that
        // re-announce approval/decline and resend an approved request to Radarr
        // or Sonarr.
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

      // Muting your own request leaves the request alone; only an explicit
      // delete removes it.
      if (request && request.requestedBy?.id === req.user?.id) {
        // Write only the flag (see unmute).
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
 * Edit a pending music request: its albums, and the Lidarr server, profiles,
 * folder and tags (the body is already limited to what the person may change).
 * Albums are added or removed as their own rows and the request is only
 * updated, so saving can't send it anywhere.
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

  // A songs request may have no albums; its songs are kept.
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

  // Albums already here or held by another open request can't be added.
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
          album.status !== MediaStatus.DELETED &&
          album.status !== MediaStatus.PARTIALLY_AVAILABLE
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
    // Albums the owner's quota already counted are paid for; a new owner is
    // charged for all.
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
    // An album nobody else wants is no longer pending.
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
      // Lock order is request then owner here, user then media on create, so no
      // cycle.
      return await requestLock.dispatch(requestKey(requestId), async () => {
        const request = await requestRepository.findOne({
          where: {
            id: requestId,
          },
        });

        if (!request) {
          return next({ status: 404, message: 'Request not found.' });
        }

        // Request type comes from the stored request, never the body: claiming
        // "tv" must not unlock editing a film request. Requesters may change a
        // series' seasons or music albums; a film has only advanced options.
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

        // Without advanced permission, keep the request's existing server,
        // profile, folder and tags.
        if (!mayChooseAdvancedOptions(req.user)) {
          req.body.serverId = request.serverId;
          req.body.profileId = request.profileId;
          req.body.rootFolder = request.rootFolder;
          req.body.languageProfileId = request.languageProfileId;
          req.body.metadataProfileId = request.metadataProfileId;
          req.body.tags = request.tags;
        }

        // Request managers may fix a failed request (e.g. pick another server)
        // before retrying.
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

        // A new server must exist and match the request's 4K-ness. The current
        // one is kept even if removed, so season edits still work; Retry then
        // uses the default server. With no server of that kind at all (manual
        // fulfilment), the id is kept as given.
        const serverProblem =
          req.body.serverId !== request.serverId
            ? chosenServerProblem({
                type: request.type,
                serverId: req.body.serverId,
                is4k: request.is4k,
              })
            : undefined;
        if (serverProblem) {
          return next({
            status: 400,
            message: CHOSEN_SERVER_MESSAGES[serverProblem],
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

        // Reassignment moves every season onto the new owner's quota, so it's
        // charged in full, not as a delta.
        const ownerChanging = requestUser.id !== previousOwnerId;

        // Anime flag from the request dialog: omitted keeps the current value,
        // null reverts to the title's setting and detection.
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
              return next({
                status: 400,
                message:
                  'Missing seasons. If you want to cancel a series request, use the DELETE method.',
              });
            }

            // Same key as create, so an edit can't claim a season a new request
            // is taking concurrently.
            return mediaLock.dispatch(
              mediaKey(MediaType.TV, request.media.tmdbId),
              async () => {
                const media = await mediaRepository.findOneOrFail({
                  where: {
                    tmdbId: request.media.tmdbId,
                    mediaType: MediaType.TV,
                  },
                  relations: { requests: true },
                });

                // Seasons requested by other requests.
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

                // Seasons the media already covers can't be requested again;
                // this request's own stay.
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

                  // Only seasons getQuota already counted for this owner are
                  // paid for, so charge for the rest.
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

        // Server removed or none set as default: the default server of its kind
        // takes it, with that server's own profile, folder and tags. With no
        // default, a manager must choose; retrying would just fail.
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

        // Release the earlier failure report, or a failure after this retry is
        // never reported.
        await releaseDelivery(request.id, Notification.MEDIA_FAILED);

        // Also updates the parent media's status and sends to *arr.
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
 * Optional decline reason; blank after trimming is none. A push notification's
 * Decline button sends no body.
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
        // Saved with the status so the declined notification and title history
        // both have it.
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
