import type { RadarrMovieOptions } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import type { AddSeriesOptions } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import SongRequest from '@server/entity/SongRequest';
import type { User } from '@server/entity/User';
import { MediaEventType, recordMediaEvent } from '@server/lib/mediaHistory';
import { lidarrApi } from '@server/lib/music/access';
import { notifyAvailableMusic } from '@server/lib/music/completion';
import { lidarrTargets } from '@server/lib/music/requestTargets';
import {
  claimDelivery,
  notifyRequestWatchers,
  releaseDelivery,
} from '@server/lib/notificationDelivery';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { requestAvailableEvent } from '@server/lib/notifications/eventTitles';
import { radarrRouting } from '@server/lib/radarrRouting';
import { markUndispatchable } from '@server/lib/requestDispatch';
import {
  chosenServerFor,
  describeServerIssue,
  requestServerIssue,
} from '@server/lib/requestServers';
import { resolveSeasonMonitorTarget } from '@server/lib/seasonMonitorTarget';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { sonarrRouting } from '@server/lib/sonarrRouting';
import logger from '@server/logger';
import { withNestedTransaction } from '@server/utils/nestedTransaction';
import { isAxiosError } from 'axios';
import { isEqual, truncate } from 'lodash';
import type {
  EntityManager,
  EntitySubscriberInterface,
  InsertEvent,
  QueryRunner,
  RemoveEvent,
  TransactionCommitEvent,
  TransactionRollbackEvent,
  UpdateEvent,
} from 'typeorm';
import { EventSubscriber, In, Not } from 'typeorm';

/** Lidarr lookup failed transiently; a retry may succeed. */
class LidarrLookupError extends Error {}

const sanitizeDisplayName = (displayName: string): string => {
  return displayName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/gi, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

/**
 * A music request's scope for its history: the one title, or a count and the
 * first few.
 */
const musicScope = (albums: string[], songs: string[]): string | undefined => {
  const titles = [...albums, ...songs];
  if (titles.length <= 1) {
    return titles[0];
  }
  const counted = (count: number, one: string, many: string) =>
    count ? [`${count} ${count === 1 ? one : many}`] : [];
  const shown = titles.slice(0, 3).join(', ');
  return `${[
    ...counted(albums.length, 'album', 'albums'),
    ...counted(songs.length, 'song', 'songs'),
  ].join(', ')}: ${shown}${titles.length > 3 ? '…' : ''}`;
};

/**
 * A watcher's copy of an availability notification. Channels and admins are
 * notified only from the requester's copy.
 */
const forWatcher = (
  payload: NotificationPayload,
  watcher: User
): NotificationPayload => ({
  ...payload,
  notifyUser: watcher,
  notifySystem: false,
  notifyAdmin: false,
});

/**
 * Reconciles Sonarr episode monitoring for this request's seasons against the
 * union of all live requests for the series.
 *
 * Episodes nobody asked for are unmonitored; episodes anyone asked for stay
 * monitored, so one user's request never cancels another's.
 */
export const applySeasonMonitoring = async (
  sonarr: SonarrAPI,
  sonarrSeriesId: number,
  entity: MediaRequest
): Promise<void> => {
  try {
    const episodes = await sonarr.getEpisodes(sonarrSeriesId);

    if (!episodes.length) {
      return;
    }

    const seasonNumbers = [
      ...new Set(entity.seasons.map((season) => season.seasonNumber)),
    ];

    const toMonitor: number[] = [];
    const toUnmonitor: number[] = [];
    const toSearch: number[] = [];

    for (const seasonNumber of seasonNumbers) {
      const target = await resolveSeasonMonitorTarget(
        entity.media.id,
        seasonNumber,
        entity.is4k
      );

      const seasonEpisodes = episodes.filter(
        (episode) => episode.seasonNumber === seasonNumber
      );

      for (const episode of seasonEpisodes) {
        const wanted =
          target.wholeSeason ||
          target.episodeNumbers.includes(episode.episodeNumber);

        if (wanted && !episode.monitored) {
          toMonitor.push(episode.id);
        }

        if (!wanted && episode.monitored) {
          toUnmonitor.push(episode.id);
        }

        // Search only wanted episodes not already on disk.
        if (wanted && !episode.hasFile) {
          toSearch.push(episode.id);
        }
      }
    }

    await sonarr.setEpisodeMonitoring(toUnmonitor, false);
    await sonarr.setEpisodeMonitoring(toMonitor, true);

    const settings = getSettings();
    const sonarrSettings = settings.sonarr.find(
      (server) => server.id === entity.serverId
    );

    if (!sonarrSettings?.preventSearch) {
      await sonarr.searchEpisodes(toSearch);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('Failed to apply episode monitoring', {
      label: 'Media Request',
      requestId: entity.id,
      errorMessage: message,
    });
    // Record on the title: Sonarr may now grab the whole season, or never
    // search the requested episodes.
    if (entity.media?.tmdbId) {
      await recordMediaEvent({
        tmdbId: entity.media.tmdbId,
        mediaType: entity.media.mediaType,
        type: MediaEventType.MONITORING_FAILED,
        is4k: !!entity.is4k,
        detail: `Sonarr was not limited to the requested episodes: ${message}`,
      });
    }
  }
};

interface RemovalContext {
  mediaId: number;
  is4k: boolean;
  serverId: number | null;
  seasonNumbers: number[];
}

// afterRemove runs after the cascade clears season relations, so beforeRemove
// captures what the reconcile needs.
const pendingRemovals = new Map<number, RemovalContext>();

/**
 * Re-reconciles Sonarr monitoring after a request is removed, against the
 * remaining requests, so removing one user's request never cancels another's
 * episodes.
 *
 * Skipped when the media row is gone (e.g. Maintainerr deleting a whole show):
 * nothing is left to monitor.
 */
const reconcileMonitoringAfterRemoval = async (
  context: RemovalContext,
  requestId: number,
  manager?: EntityManager
): Promise<void> => {
  const { seasonNumbers, mediaId, is4k, serverId } = context;

  if (!seasonNumbers.length) {
    return;
  }

  let title: Pick<Media, 'tmdbId' | 'mediaType'> | undefined;

  try {
    const media = await (manager ?? getRepository(Media).manager)
      .getRepository(Media)
      .findOne({ where: { id: mediaId } });

    if (!media) {
      return;
    }

    title = { tmdbId: media.tmdbId, mediaType: media.mediaType };

    const externalServiceId =
      media[is4k ? 'externalServiceId4k' : 'externalServiceId'];

    if (!externalServiceId) {
      return;
    }

    const settings = getSettings();
    const sonarrSettings = settings.sonarr.find(
      (server) => server.id === serverId
    );

    if (!sonarrSettings) {
      return;
    }

    const sonarr = new SonarrAPI({
      apiKey: sonarrSettings.apiKey,
      url: SonarrAPI.buildUrl(sonarrSettings, '/api/v3'),
    });

    const episodes = await sonarr.getEpisodes(externalServiceId);
    const toUnmonitor: number[] = [];

    for (const seasonNumber of seasonNumbers) {
      const target = await resolveSeasonMonitorTarget(
        media.id,
        seasonNumber,
        is4k,
        { manager, excludeRequestId: requestId }
      );

      if (target.wholeSeason) {
        continue;
      }

      for (const episode of episodes) {
        if (episode.seasonNumber !== seasonNumber || !episode.monitored) {
          continue;
        }

        if (!target.episodeNumbers.includes(episode.episodeNumber)) {
          toUnmonitor.push(episode.id);
        }
      }
    }

    await sonarr.setEpisodeMonitoring(toUnmonitor, false);
  } catch (e) {
    logger.error('Failed to reconcile monitoring after request removal', {
      label: 'Media Request',
      requestId,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    // Record on the title: Sonarr may keep monitoring and downloading unwanted
    // episodes.
    if (title) {
      await recordMediaEvent({
        tmdbId: title.tmdbId,
        mediaType: title.mediaType,
        type: MediaEventType.MONITORING_FAILED,
        is4k,
        detail: `Sonarr still monitors episodes no longer requested: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }
  }
};

/**
 * Lidarr sends deferred until the approving save commits, keyed by that save's
 * connection.
 */
const lidarrSendsAfterCommit = new WeakMap<QueryRunner, (() => void)[]>();

/**
 * Whether Lidarr refused an add because it already has the artist or album (per
 * its response body).
 */
const addedMeanwhile = (e: unknown): boolean => {
  for (let at: unknown = e; at; at = (at as { cause?: unknown }).cause) {
    if (
      isAxiosError(at) &&
      /already (been )?(added|exists)/i.test(JSON.stringify(at.response?.data))
    ) {
      return true;
    }
    if (!(at instanceof Error)) break;
  }
  return false;
};

/** Statuses of a request's albums and songs still to come. */
const OPEN_PARTS = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
  MediaRequestStatus.FAILED,
];

@EventSubscriber()
export class MediaRequestSubscriber implements EntitySubscriberInterface<MediaRequest> {
  /**
   * Blocklisted titles are never sent to Radarr or Sonarr, even for requests
   * approved before the blocklist.
   */
  private async titleBlocklisted(
    entity: MediaRequest,
    manager: EntityManager
  ): Promise<boolean> {
    const media = await manager.getRepository(Media).findOne({
      where: { id: entity.media.id },
    });

    if (
      media?.status !== MediaStatus.BLOCKLISTED &&
      media?.status4k !== MediaStatus.BLOCKLISTED
    ) {
      return false;
    }

    logger.info('Not sending a request for a blocklisted title', {
      label: 'Media Request',
      requestId: entity.id,
      mediaId: entity.media.id,
    });

    return true;
  }

  private async notifyAvailableMovie(
    entity: MediaRequest,
    event?: UpdateEvent<MediaRequest>
  ) {
    // Prefer the save's own manager, which sees its uncommitted status.
    const query = { where: { id: entity.media.id } };
    const latestMedia =
      (event?.manager && (await event.manager.findOne(Media, query))) ||
      (await getRepository(Media).findOne(query));

    if (
      !latestMedia ||
      latestMedia[entity.is4k ? 'status4k' : 'status'] !== MediaStatus.AVAILABLE
    ) {
      return;
    }

    if (!(await claimDelivery(entity.id, Notification.MEDIA_AVAILABLE))) {
      return;
    }

    const tmdb = new TheMovieDb();

    try {
      const movie = await tmdb.getMovie({
        movieId: entity.media.tmdbId,
      });

      const moviePayload: NotificationPayload = {
        ...requestAvailableEvent(MediaType.MOVIE, entity.is4k),
        notifyAdmin: false,
        notifySystem: true,
        notifyUser: entity.requesterMuted ? undefined : entity.requestedBy,
        subject: `${movie.title}${
          movie.release_date ? ` (${movie.release_date.slice(0, 4)})` : ''
        }`,
        message: truncate(movie.overview, {
          length: 500,
          separator: /\s/,
          omission: '…',
        }),
        media: latestMedia,
        image: movie.poster_path
          ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${movie.poster_path}`
          : undefined,
        request: entity,
      };

      notificationManager.sendNotification(
        Notification.MEDIA_AVAILABLE,
        moviePayload
      );

      await notifyRequestWatchers(entity.id, (watcher) => {
        notificationManager.sendNotification(
          Notification.MEDIA_AVAILABLE,
          forWatcher(moviePayload, watcher)
        );
        return true;
      });
    } catch (e) {
      await releaseDelivery(entity.id, Notification.MEDIA_AVAILABLE);

      logger.error('Something went wrong sending media notification(s)', {
        label: 'Notifications',
        errorMessage: e.message,
        mediaId: entity.id,
      });
    }
  }

  private async notifyAvailableSeries(
    entity: MediaRequest,
    event?: UpdateEvent<MediaRequest>
  ) {
    // Prefer the save's own manager, which sees its uncommitted status.
    const query = {
      where: { id: entity.media.id },
      relations: { seasons: true },
    };
    const latestMedia =
      (event?.manager && (await event.manager.findOne(Media, query))) ||
      (await getRepository(Media).findOne(query));

    if (!latestMedia) {
      return;
    }

    const requestedSeasons =
      entity.seasons?.map((entitySeason) => entitySeason.seasonNumber) ?? [];
    const availableSeasons = latestMedia.seasons.filter(
      (season) =>
        season[entity.is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE &&
        requestedSeasons.includes(season.seasonNumber)
    );
    const isMediaAvailable =
      availableSeasons.length > 0 &&
      availableSeasons.length === requestedSeasons.length;

    if (!isMediaAvailable) {
      return;
    }

    if (!(await claimDelivery(entity.id, Notification.MEDIA_AVAILABLE))) {
      return;
    }

    const tmdb = new TheMovieDb();

    try {
      const tv = await tmdb.getTvShow({ tvId: entity.media.tmdbId });

      const seriesPayload: NotificationPayload = {
        ...requestAvailableEvent(MediaType.TV, entity.is4k),
        subject: `${tv.name}${
          tv.first_air_date ? ` (${tv.first_air_date.slice(0, 4)})` : ''
        }`,
        message: truncate(tv.overview, {
          length: 500,
          separator: /\s/,
          omission: '…',
        }),
        notifyAdmin: false,
        notifySystem: true,
        notifyUser: entity.requesterMuted ? undefined : entity.requestedBy,
        image: tv.poster_path
          ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${tv.poster_path}`
          : undefined,
        media: latestMedia,
        extra: [
          {
            name: 'Requested Seasons',
            value: entity.seasons
              .map((season) => season.seasonNumber)
              .join(', '),
          },
        ],
        request: entity,
      };

      notificationManager.sendNotification(
        Notification.MEDIA_AVAILABLE,
        seriesPayload
      );

      await notifyRequestWatchers(entity.id, (watcher) => {
        notificationManager.sendNotification(
          Notification.MEDIA_AVAILABLE,
          forWatcher(seriesPayload, watcher)
        );
        return true;
      });
    } catch (e) {
      await releaseDelivery(entity.id, Notification.MEDIA_AVAILABLE);

      logger.error('Something went wrong sending media notification(s)', {
        label: 'Notifications',
        errorMessage: e.message,
        mediaId: entity.id,
      });
    }
  }

  public async sendToRadarr(
    entity: MediaRequest,
    manager: EntityManager
  ): Promise<void> {
    if (
      entity.status === MediaRequestStatus.APPROVED &&
      entity.type === MediaType.MOVIE
    ) {
      if (await this.titleBlocklisted(entity, manager)) {
        return;
      }

      try {
        const mediaRepository = manager.getRepository(Media);
        const settings = getSettings();
        // No Radarr at all means requests are fulfilled by hand: stay approved.
        if (settings.radarr.length === 0 && !settings.radarr[0]) {
          logger.info(
            'No Radarr server configured, skipping request processing',
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
          return;
        }

        const media = await mediaRepository.findOne({
          where: { id: entity.media.id },
        });

        if (!media) {
          logger.error('Media data not found', {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          });
          return;
        }

        if (
          media[entity.is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE
        ) {
          logger.warn('Media already exists, marking request as COMPLETED', {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          });

          const requestRepository = manager.getRepository(MediaRequest);
          entity.status = MediaRequestStatus.COMPLETED;
          await requestRepository.save(entity);
          return;
        }

        // Server removed or no default: fail with the reason instead of staying
        // approved with nothing sent.
        const serverIssue = requestServerIssue(entity, settings);
        if (serverIssue) {
          await markUndispatchable(
            entity,
            describeServerIssue(serverIssue, entity.is4k),
            manager
          );
          return;
        }

        let radarrSettings = settings.radarr.find(
          (radarr) => radarr.isDefault && radarr.is4k === entity.is4k
        );

        if (
          entity.serverId !== null &&
          entity.serverId >= 0 &&
          radarrSettings?.id !== entity.serverId
        ) {
          // requestServerIssue guarantees a server of the right 4K kind.
          radarrSettings = chosenServerFor(entity, settings) as
            | typeof radarrSettings
            | undefined;
          logger.info(
            `Request has an override server: ${radarrSettings?.name}`,
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
        }

        if (!radarrSettings) {
          return;
        }

        const tmdb = new TheMovieDb();
        const radarr = new RadarrAPI({
          apiKey: radarrSettings.apiKey,
          url: RadarrAPI.buildUrl(radarrSettings, '/api/v3'),
        });
        const movie = await tmdb.getMovie({ movieId: entity.media.tmdbId });

        const routing = radarrRouting(
          movie,
          radarrSettings,
          entity.seriesType,
          media.animeSetting
        );
        let { rootFolder, qualityProfile, tags } = routing;
        logger.debug(
          `Sending as ${routing.anime ? 'anime' : 'a standard movie'} (${
            routing.decidedBy === 'title'
              ? 'set on the title'
              : routing.decidedBy === 'request'
                ? 'chosen for the request'
                : 'detected'
          })`,
          {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          }
        );

        if (
          entity.rootFolder &&
          entity.rootFolder !== '' &&
          entity.rootFolder !== rootFolder
        ) {
          rootFolder = entity.rootFolder;
          logger.info(`Request has an override root folder: ${rootFolder}`, {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          });
        }

        if (entity.profileId && entity.profileId !== qualityProfile) {
          qualityProfile = entity.profileId;
          logger.info(
            `Request has an override quality profile ID: ${qualityProfile}`,
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
        }

        if (entity.tags && !isEqual(entity.tags, tags)) {
          tags = entity.tags;
          logger.info(`Request has override tags`, {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
            tagIds: tags,
          });
        }

        if (radarrSettings.tagRequests) {
          const userTag = await this.requesterTag(radarr, entity, 'Radarr');
          if (userTag !== undefined && !tags?.includes(userTag)) {
            tags?.push(userTag);
          }
        }

        const radarrMovieOptions: RadarrMovieOptions = {
          profileId: qualityProfile,
          qualityProfileId: qualityProfile,
          rootFolderPath: rootFolder,
          minimumAvailability: radarrSettings.minimumAvailability,
          title: movie.title,
          tmdbId: movie.id,
          year: Number(movie.release_date.slice(0, 4)),
          monitored: true,
          tags,
          searchNow: !radarrSettings.preventSearch,
        };

        // Not awaited, so the UI doesn't wait on Radarr.
        radarr
          .addMovie(radarrMovieOptions)
          .then(async (radarrMovie) => {
            // Runs detached from the request transaction, so use the global
            // repository and refetch media.
            const mediaRepository = getRepository(Media);
            const media = await mediaRepository.findOne({
              where: { id: entity.media.id },
            });

            if (!media) {
              throw new Error('Media data not found');
            }

            media[entity.is4k ? 'externalServiceId4k' : 'externalServiceId'] =
              radarrMovie.id;
            media[
              entity.is4k ? 'externalServiceSlug4k' : 'externalServiceSlug'
            ] = radarrMovie.titleSlug;
            media[entity.is4k ? 'serviceId4k' : 'serviceId'] =
              radarrSettings?.id;
            await mediaRepository.save(media);
          })
          .catch(async () => {
            try {
              const requestRepository = getRepository(MediaRequest);

              if (entity.status !== MediaRequestStatus.FAILED) {
                entity.status = MediaRequestStatus.FAILED;
                await requestRepository.save(entity);
              }
            } catch (saveError) {
              logger.error('Failed to mark request as FAILED', {
                label: 'Media Request',
                requestId: entity.id,
                errorMessage:
                  saveError instanceof Error
                    ? saveError.message
                    : String(saveError),
              });
            }

            logger.warn(
              'Something went wrong sending movie request to Radarr, marking status as FAILED',
              {
                label: 'Media Request',
                requestId: entity.id,
                mediaId: entity.media.id,
                radarrMovieOptions,
              }
            );

            if (await claimDelivery(entity.id, Notification.MEDIA_FAILED)) {
              MediaRequest.sendNotification(
                entity,
                media,
                Notification.MEDIA_FAILED
              );
            }
          })
          .finally(() => {
            radarr.clearCache({
              tmdbId: movie.id,
              externalId: entity.is4k
                ? media.externalServiceId4k
                : media.externalServiceId,
            });
          });
        logger.info('Sent request to Radarr', {
          label: 'Media Request',
          requestId: entity.id,
          mediaId: entity.media.id,
        });
      } catch (e) {
        const requestRepository = manager.getRepository(MediaRequest);
        const mediaRepository = manager.getRepository(Media);
        const media = await mediaRepository.findOne({
          where: { id: entity.media.id },
        });

        if (media) {
          entity.status = MediaRequestStatus.FAILED;
          await requestRepository.save(entity);

          logger.warn(
            'Failed to send movie request to Radarr due to connection or configuration error, marking status as FAILED',
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              errorMessage: e.message,
            }
          );

          if (await claimDelivery(entity.id, Notification.MEDIA_FAILED)) {
            MediaRequest.sendNotification(
              entity,
              media,
              Notification.MEDIA_FAILED
            );
          }
        }
      }
    }
  }

  public async sendToSonarr(
    entity: MediaRequest,
    manager: EntityManager
  ): Promise<void> {
    if (
      entity.status === MediaRequestStatus.APPROVED &&
      entity.type === MediaType.TV
    ) {
      if (await this.titleBlocklisted(entity, manager)) {
        return;
      }

      try {
        const mediaRepository = manager.getRepository(Media);
        const settings = getSettings();
        if (settings.sonarr.length === 0 && !settings.sonarr[0]) {
          logger.warn(
            'No Sonarr server configured, skipping request processing',
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
          return;
        }

        const media = await mediaRepository.findOne({
          where: { id: entity.media.id },
        });

        if (!media) {
          throw new Error('Media data not found');
        }

        if (
          media[entity.is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE
        ) {
          logger.warn('Media already exists, marking request as COMPLETED', {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          });

          const requestRepository = manager.getRepository(MediaRequest);
          entity.status = MediaRequestStatus.COMPLETED;
          entity.seasons.forEach((season) => {
            season.status = MediaRequestStatus.COMPLETED;
          });
          await requestRepository.save(entity);
          return;
        }

        const serverIssue = requestServerIssue(entity, settings);
        if (serverIssue) {
          await markUndispatchable(
            entity,
            describeServerIssue(serverIssue, entity.is4k),
            manager
          );
          return;
        }

        let sonarrSettings = settings.sonarr.find(
          (sonarr) => sonarr.isDefault && sonarr.is4k === entity.is4k
        );

        if (
          entity.serverId !== null &&
          entity.serverId >= 0 &&
          sonarrSettings?.id !== entity.serverId
        ) {
          // requestServerIssue guarantees a server of the right 4K kind.
          sonarrSettings = chosenServerFor(entity, settings) as
            | typeof sonarrSettings
            | undefined;
          logger.info(
            `Request has an override server: ${sonarrSettings?.name}`,
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
        }

        if (!sonarrSettings) {
          return;
        }

        const tmdb = new TheMovieDb();
        const sonarr = new SonarrAPI({
          apiKey: sonarrSettings.apiKey,
          url: SonarrAPI.buildUrl(sonarrSettings, '/api/v3'),
        });
        const series = await tmdb.getTvShow({ tvId: media.tmdbId });
        const tvdbId = series.external_ids.tvdb_id ?? media.tvdbId;

        if (!tvdbId) {
          // Keep the media row and request and mark the request failed.
          // Deleting both left no trace, so watchlist sync re-requested the
          // title every run (insert, notify, delete), e.g. when TVDB folded a
          // series into an anthology and the TMDB entry lost its TVDB id. A
          // failed request is visible to admins and stops the loop via the
          // duplicate guard.
          await markUndispatchable(
            entity,
            'No TVDB ID could be resolved for this series, so it cannot be sent to Sonarr; marked failed',
            manager
          );
          return;
        }

        const routing = sonarrRouting(
          series,
          sonarrSettings,
          entity.seriesType,
          media.animeSetting
        );
        const { seriesType } = routing;
        let { rootFolder, qualityProfile, languageProfile, tags } = routing;
        logger.debug(
          `Sending as ${routing.anime ? 'anime' : 'a standard series'} (${
            routing.decidedBy === 'title'
              ? 'set on the title'
              : routing.decidedBy === 'request'
                ? 'chosen for the request'
                : 'detected'
          })`,
          {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
            seriesType,
          }
        );

        if (
          entity.rootFolder &&
          entity.rootFolder !== '' &&
          entity.rootFolder !== rootFolder
        ) {
          rootFolder = entity.rootFolder;
          logger.info(`Request has an override root folder: ${rootFolder}`, {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
          });
        }

        if (entity.profileId && entity.profileId !== qualityProfile) {
          qualityProfile = entity.profileId;
          logger.info(
            `Request has an override quality profile ID: ${qualityProfile}`,
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
        }

        if (
          entity.languageProfileId &&
          entity.languageProfileId !== languageProfile
        ) {
          languageProfile = entity.languageProfileId;
          logger.info(
            `Request has an override language profile ID: ${languageProfile}`,
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
            }
          );
        }

        if (entity.tags && !isEqual(entity.tags, tags)) {
          tags = entity.tags;
          logger.info(`Request has override tags`, {
            label: 'Media Request',
            requestId: entity.id,
            mediaId: entity.media.id,
            tagIds: tags,
          });
        }

        if (sonarrSettings.tagRequests) {
          const userTag = await this.requesterTag(sonarr, entity, 'Sonarr');
          if (userTag !== undefined && !tags?.includes(userTag)) {
            tags?.push(userTag);
          }
        }

        const sonarrSeriesOptions: AddSeriesOptions = {
          profileId: qualityProfile,
          languageProfileId: languageProfile,
          rootFolderPath: rootFolder,
          title: series.name,
          tvdbid: tvdbId,
          seasons: entity.seasons.map((season) => season.seasonNumber),
          seasonFolder: sonarrSettings.enableSeasonFolders,
          seriesType,
          tags,
          monitored: true,
          monitorNewItems: sonarrSettings.monitorNewItems,
          searchNow: !sonarrSettings.preventSearch,
        };

        // Not awaited, so the UI doesn't wait on Sonarr.
        sonarr
          .addSeries(sonarrSeriesOptions)
          .then(async (sonarrSeries) => {
            // Runs detached from the request transaction, so use the global
            // repository and refetch media.
            const mediaRepository = getRepository(Media);
            const media = await mediaRepository.findOne({
              where: { id: entity.media.id },
            });

            if (!media) {
              throw new Error('Media data not found');
            }

            media[entity.is4k ? 'externalServiceId4k' : 'externalServiceId'] =
              sonarrSeries.id;
            media[
              entity.is4k ? 'externalServiceSlug4k' : 'externalServiceSlug'
            ] = sonarrSeries.titleSlug;
            media[entity.is4k ? 'serviceId4k' : 'serviceId'] =
              sonarrSettings?.id;
            await mediaRepository.save(media);

            await applySeasonMonitoring(
              sonarr,
              sonarrSeries.id as number,
              entity
            );
          })
          .catch(async () => {
            try {
              const requestRepository = getRepository(MediaRequest);

              if (entity.status !== MediaRequestStatus.FAILED) {
                entity.status = MediaRequestStatus.FAILED;
                await requestRepository.save(entity);
              }
            } catch (saveError) {
              logger.error('Failed to mark request as FAILED', {
                label: 'Media Request',
                requestId: entity.id,
                errorMessage:
                  saveError instanceof Error
                    ? saveError.message
                    : String(saveError),
              });
            }

            logger.warn(
              'Something went wrong sending series request to Sonarr, marking status as FAILED',
              {
                label: 'Media Request',
                requestId: entity.id,
                mediaId: entity.media.id,
                sonarrSeriesOptions,
              }
            );

            if (await claimDelivery(entity.id, Notification.MEDIA_FAILED)) {
              MediaRequest.sendNotification(
                entity,
                media,
                Notification.MEDIA_FAILED
              );
            }
          })
          .finally(() => {
            sonarr.clearCache({
              tvdbId,
              externalId: entity.is4k
                ? media.externalServiceId4k
                : media.externalServiceId,
              title: series.name,
            });
          });
        logger.info('Sent request to Sonarr', {
          label: 'Media Request',
          requestId: entity.id,
          mediaId: entity.media.id,
        });
      } catch (e) {
        const requestRepository = manager.getRepository(MediaRequest);
        const mediaRepository = manager.getRepository(Media);
        const media = await mediaRepository.findOne({
          where: { id: entity.media.id },
        });

        if (media) {
          entity.status = MediaRequestStatus.FAILED;
          await requestRepository.save(entity);

          logger.warn(
            'Failed to send series request to Sonarr due to connection or configuration error, marking status as FAILED',
            {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              errorMessage: e.message,
            }
          );

          if (await claimDelivery(entity.id, Notification.MEDIA_FAILED)) {
            MediaRequest.sendNotification(
              entity,
              media,
              Notification.MEDIA_FAILED
            );
          }
        }
      }
    }
  }

  /**
   * Sends an approved music request to Lidarr. The server is chosen in the
   * request's save; the Lidarr calls run after that save commits
   * (dispatchToLidarr), so approval doesn't wait on Lidarr or its metadata
   * service.
   */
  public async sendToLidarr(
    entity: MediaRequest,
    manager: EntityManager
  ): Promise<void> {
    if (
      entity.status !== MediaRequestStatus.APPROVED ||
      entity.type !== MediaType.MUSIC
    ) {
      return;
    }
    // Songs go via their singles. A song only on albums isn't sent yet; a
    // request with nothing else to send stays approved.
    if (!lidarrTargets(entity, OPEN_PARTS).length) {
      return;
    }
    if (await this.titleBlocklisted(entity, manager)) {
      return;
    }

    const settings = getSettings();
    // As with Radarr and Sonarr, no Lidarr at all leaves it approved.
    if (!settings.lidarr.length) {
      logger.info('No Lidarr server configured, skipping request processing', {
        label: 'Media Request',
        requestId: entity.id,
        mediaId: entity.media?.id,
      });
      return;
    }
    const serverIssue = requestServerIssue(entity, settings);
    if (serverIssue) {
      await markUndispatchable(
        entity,
        describeServerIssue(serverIssue),
        manager
      );
      await this.failSongsThroughSingles(entity, manager);
      return;
    }
    const lidarrSettings =
      entity.serverId !== null &&
      entity.serverId !== undefined &&
      entity.serverId >= 0
        ? settings.lidarr.find((server) => server.id === entity.serverId)
        : settings.lidarr.find((server) => server.isDefault);
    if (!lidarrSettings) {
      return;
    }

    // Never rejects: failures mark the request failed with the reason.
    const send = () => void this.dispatchToLidarr(entity, lidarrSettings);

    // Send after the save commits. Started inside it, a quick failure was
    // written on another connection that couldn't see the new request yet
    // (Postgres), so the request stayed approved while "failed" notifications
    // went out.
    const queryRunner = manager.queryRunner;
    if (!queryRunner?.isTransactionActive) {
      send();
      return;
    }
    const waiting = lidarrSendsAfterCommit.get(queryRunner) ?? [];
    waiting.push(() => {
      // Skip if the save was rolled back or the request changed since.
      getRepository(MediaRequest)
        .exists({
          where: { id: entity.id, status: MediaRequestStatus.APPROVED },
        })
        .then((approved) => {
          if (approved) {
            send();
          }
        })
        .catch((e) => {
          logger.error('Could not send an approved request to Lidarr', {
            label: 'Media Request',
            requestId: entity.id,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
        });
    });
    lidarrSendsAfterCommit.set(queryRunner, waiting);
  }

  public afterTransactionCommit(event: TransactionCommitEvent): void {
    // Releasing a savepoint is not the outer commit.
    if (event.queryRunner.isTransactionActive) {
      return;
    }
    const waiting = lidarrSendsAfterCommit.get(event.queryRunner);
    lidarrSendsAfterCommit.delete(event.queryRunner);
    waiting?.forEach((send) => send());
  }

  public afterTransactionRollback(event: TransactionRollbackEvent): void {
    if (!event.queryRunner.isTransactionActive) {
      lidarrSendsAfterCommit.delete(event.queryRunner);
    }
  }

  /**
   * The Lidarr half of sendToLidarr. Lidarr is only told to monitor and search
   * for what was asked: nothing is unmonitored, and an existing artist keeps
   * its folder, profiles and new-release setting, so one request never undoes
   * another.
   *
   * - New artist, one album: add the album with the artist set up around it,
   *   nothing else monitored.
   * - New artist, several albums: add the artist with exactly those albums
   *   monitored (albumsToMonitor unmonitors every other album, so it is only
   *   used for new artists).
   * - Existing artist: monitor the albums it has, add the missing ones, monitor
   *   the artist if needed, and search the albums it had.
   */
  public async dispatchToLidarr(
    entity: MediaRequest,
    lidarrSettings: LidarrSettings,
    again = false
  ): Promise<void> {
    const lidarr = lidarrApi(lidarrSettings);
    const search = !lidarrSettings.preventSearch;
    // Its albums and its songs' singles, minus those done (on retry, only
    // what's still missing).
    const wanted = lidarrTargets(entity, OPEN_PARTS).map(
      (target) => target.mbId
    );
    let media: Media | null = null;

    try {
      media = await getRepository(Media).findOne({
        where: { id: entity.media.id },
      });
      if (!media?.foreignId || !wanted.length) {
        throw new Error('The request has no artist or albums to send.');
      }
      const artistMbid = media.foreignId;

      const requesterTag = lidarrSettings.tagRequests
        ? await this.requesterTag(lidarr, entity, 'Lidarr')
        : undefined;
      const tags = [...(entity.tags ?? lidarrSettings.tags ?? [])];
      if (requesterTag !== undefined && !tags.includes(requesterTag)) {
        tags.push(requesterTag);
      }
      const setup = {
        qualityProfileId: entity.profileId || lidarrSettings.activeProfileId,
        metadataProfileId:
          entity.metadataProfileId || lidarrSettings.activeMetadataProfileId,
        rootFolderPath: entity.rootFolder || lidarrSettings.activeDirectory,
        tags,
        monitored: true,
        monitorNewItems: 'none' as const,
      };

      const albumIds = new Map<string, number>();
      let artist = await lidarr.getArtistByMbid(artistMbid);

      if (!artist && wanted.length === 1) {
        const album = await lidarr.lookupAlbum(wanted[0]);
        if (!album) {
          throw new LidarrLookupError(
            'Lidarr couldn’t look up this album yet. Retry later.'
          );
        }
        const found =
          album.artist?.foreignArtistId === artistMbid
            ? album.artist
            : await lidarr.lookupArtist(artistMbid);
        if (!found) {
          throw new LidarrLookupError(
            'Lidarr couldn’t look up this artist yet. Retry later.'
          );
        }
        const added = await lidarr.addAlbum(album, {
          artist: {
            ...found,
            ...setup,
            addOptions: {
              monitor: 'none' as const,
              searchForMissingAlbums: false,
            },
          },
          searchForNewAlbum: search,
        });
        albumIds.set(wanted[0], added.id);
        artist = added.artist ?? {
          ...found,
          id: added.artistId,
        };
      } else if (!artist) {
        const found = await lidarr.lookupArtist(artistMbid);
        if (!found) {
          throw new LidarrLookupError(
            'Lidarr couldn’t look up this artist yet. Retry later.'
          );
        }
        // Albums outside the metadata profile aren't listed yet; music sync
        // adds them after Lidarr refreshes the artist.
        artist = await lidarr.addArtist(found, {
          ...setup,
          addOptions: {
            monitor: 'none',
            albumsToMonitor: wanted,
            searchForMissingAlbums: search,
          },
        });
      } else {
        const known = new Map(
          (await lidarr.getAlbums({ artistId: artist.id })).map((album) => [
            album.foreignAlbumId,
            album,
          ])
        );
        const present = wanted.flatMap((id) => {
          const album = known.get(id);
          return album ? [album] : [];
        });
        for (const album of present) {
          albumIds.set(album.foreignAlbumId, album.id);
        }
        await lidarr.monitorAlbums(
          present.map((album) => album.id),
          true
        );

        const waiting: string[] = [];
        for (const id of wanted.filter((id) => !known.has(id))) {
          const album = await lidarr.lookupAlbum(id);
          if (!album) {
            waiting.push(id);
            continue;
          }
          const added = await lidarr.addAlbum(album, {
            artist,
            searchForNewAlbum: search,
          });
          albumIds.set(id, added.id);
        }
        if (!albumIds.size) {
          throw new LidarrLookupError(
            'Lidarr couldn’t look up these albums yet. Retry later.'
          );
        }
        if (waiting.length) {
          logger.info('Lidarr cannot look up some albums yet; they wait', {
            label: 'Media Request',
            requestId: entity.id,
            albums: waiting,
          });
        }

        // Lidarr only fetches what both the artist and the album monitor.
        const addTag =
          requesterTag !== undefined && !artist.tags.includes(requesterTag);
        if (!artist.monitored || addTag) {
          artist = await lidarr.updateArtist({
            ...artist,
            monitored: true,
            tags: addTag ? [...artist.tags, requesterTag] : artist.tags,
          });
        }

        if (search && present.length) {
          await lidarr.searchAlbums(present.map((album) => album.id));
        }
      }

      await getRepository(Media).update(media.id, {
        serviceId: lidarrSettings.id,
        externalServiceId: artist.id,
        externalServiceSlug: artist.foreignArtistId || artistMbid,
      });
      for (const [mbId, lidarrAlbumId] of albumIds) {
        await getRepository(MusicAlbum).update(
          { mediaId: media.id, mbId },
          { lidarrAlbumId }
        );
      }

      logger.info('Sent request to Lidarr', {
        label: 'Media Request',
        requestId: entity.id,
        mediaId: entity.media.id,
      });
    } catch (e) {
      // Music sync added it meanwhile; resending finds it there.
      if (!again && addedMeanwhile(e)) {
        return this.dispatchToLidarr(entity, lidarrSettings, true);
      }
      const reason =
        e instanceof LidarrLookupError
          ? e.message
          : `Lidarr could not take the request: ${
              e instanceof Error ? e.message : String(e)
            }`;
      await markUndispatchable(entity, reason);
      await this.failSongsThroughSingles(entity);

      // No failure notification here: the notification reconciler sends it
      // within minutes, batching a playlist's requests once they settle. From
      // here a playlist's would go one by one, before the playlist may have
      // claimed the request.
    }
  }

  /**
   * Fails the songs that were to come via singles when Lidarr can't take a
   * request (they can be retried). Songs taken from albums are fetched by Seerr
   * AI and continue.
   */
  private async failSongsThroughSingles(
    entity: MediaRequest,
    manager?: EntityManager
  ): Promise<void> {
    if (entity.status !== MediaRequestStatus.FAILED) return;
    const songs = (entity.songs ?? []).filter(
      (song) => !!song.singleMbid && song.status === MediaRequestStatus.APPROVED
    );
    if (!songs.length) return;
    await (manager ?? getRepository(SongRequest).manager).update(
      SongRequest,
      { id: In(songs.map((song) => song.id)) },
      { status: MediaRequestStatus.FAILED }
    );
    songs.forEach((song) => (song.status = MediaRequestStatus.FAILED));
  }

  /**
   * The requester's tag ("12-alex") in Radarr, Sonarr or Lidarr, created if
   * missing. Only a sorting label: if it can't be had, the request is sent
   * without it rather than failed.
   */
  private async requesterTag(
    api: Pick<RadarrAPI, 'getTags' | 'createTag'>,
    entity: MediaRequest,
    server: 'Radarr' | 'Sonarr' | 'Lidarr'
  ): Promise<number | undefined> {
    const label = `${entity.requestedBy.id}-${sanitizeDisplayName(
      entity.requestedBy.displayName
    )}`;
    try {
      // Older tags had spaces around the hyphen, which are no longer allowed.
      const existing = (await api.getTags()).find(
        (tag) =>
          tag.label.startsWith(`${entity.requestedBy.id} - `) ||
          tag.label.startsWith(`${entity.requestedBy.id}-`)
      );
      const tag = existing ?? (await api.createTag({ label }));
      if (!existing) {
        logger.info(`Made the requester's tag in ${server}`, {
          label: 'Media Request',
          requestId: entity.id,
          userId: entity.requestedBy.id,
          newTag: label,
        });
      }
      return tag.id || undefined;
    } catch (e) {
      logger.warn(
        `${server} couldn't give the requester's tag; sent without it`,
        {
          label: 'Media Request',
          requestId: entity.id,
          userId: entity.requestedBy.id,
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );
      return undefined;
    }
  }

  /**
   * Updates an approved or declined music request's albums: approved ones are
   * on their way; declined ones revert to unrequested unless another request
   * still wants them.
   */
  private async updateMusicAlbums(
    manager: EntityManager,
    entity: MediaRequest
  ): Promise<void> {
    // Its songs follow its status.
    const songs = (entity.songs ?? []).filter(
      (song) =>
        song.status !== MediaRequestStatus.COMPLETED &&
        song.status !== MediaRequestStatus.DECLINED
    );
    if (
      songs.length &&
      (entity.status === MediaRequestStatus.APPROVED ||
        entity.status === MediaRequestStatus.DECLINED)
    ) {
      await manager
        .getRepository(SongRequest)
        .update(
          { id: In(songs.map((song) => song.id)) },
          { status: entity.status }
        );
      songs.forEach((song) => (song.status = entity.status));
    }

    // On re-approval (retry), done or declined albums keep their status.
    const albums = (entity.albums ?? []).filter(
      (album) =>
        entity.status !== MediaRequestStatus.APPROVED ||
        OPEN_PARTS.includes(album.status)
    );
    // Its albums' rows plus its songs' singles.
    const mbIds = lidarrTargets(
      entity,
      entity.status === MediaRequestStatus.APPROVED ? OPEN_PARTS : undefined
    ).map((target) => target.mbId);
    if (!mbIds.length) {
      return;
    }
    const albumRequests = manager.getRepository(AlbumRequest);
    const musicAlbums = manager.getRepository(MusicAlbum);

    if (entity.status === MediaRequestStatus.APPROVED) {
      if (albums.length) {
        await albumRequests.update(
          { id: In(albums.map((album) => album.id)) },
          { status: MediaRequestStatus.APPROVED }
        );
        albums.forEach((album) => (album.status = MediaRequestStatus.APPROVED));
      }
      await musicAlbums.update(
        {
          mediaId: entity.media.id,
          mbId: In(mbIds),
          status: In([
            MediaStatus.UNKNOWN,
            MediaStatus.PENDING,
            MediaStatus.DELETED,
          ]),
        },
        { status: MediaStatus.PROCESSING }
      );
    }

    if (entity.status === MediaRequestStatus.DECLINED) {
      if (albums.length) {
        await albumRequests.update(
          { id: In(albums.map((album) => album.id)) },
          { status: MediaRequestStatus.DECLINED }
        );
        albums.forEach((album) => (album.status = MediaRequestStatus.DECLINED));
      }
      const stillWanted = await this.albumsStillWanted(
        manager,
        entity.media.id,
        entity.id
      );
      const free = mbIds.filter((id) => !stillWanted.has(id));
      if (free.length) {
        await musicAlbums.update(
          {
            mediaId: entity.media.id,
            mbId: In(free),
            status: MediaStatus.PENDING,
          },
          { status: MediaStatus.UNKNOWN }
        );
      }
    }
  }

  /**
   * Albums another open request for the artist still wants, directly or as a
   * song's single.
   */
  private async albumsStillWanted(
    manager: EntityManager,
    mediaId: number,
    exceptRequestId?: number
  ): Promise<Set<string>> {
    const singles = manager
      .getRepository(SongRequest)
      .createQueryBuilder('song')
      .innerJoin('song.request', 'request')
      .select('song.singleMbid', 'singleMbid')
      .where('request.mediaId = :mediaId', { mediaId })
      .andWhere('song.singleMbid IS NOT NULL')
      .andWhere('request.status NOT IN (:...statuses)', {
        statuses: [MediaRequestStatus.DECLINED, MediaRequestStatus.COMPLETED],
      });
    if (exceptRequestId !== undefined) {
      singles.andWhere('request.id != :exceptRequestId', { exceptRequestId });
    }
    const query = manager
      .getRepository(AlbumRequest)
      .createQueryBuilder('album')
      .innerJoin('album.request', 'request')
      .select('album.albumMbid', 'albumMbid')
      .where('request.mediaId = :mediaId', { mediaId })
      .andWhere('request.status NOT IN (:...statuses)', {
        statuses: [MediaRequestStatus.DECLINED, MediaRequestStatus.COMPLETED],
      });
    if (exceptRequestId !== undefined) {
      query.andWhere('request.id != :exceptRequestId', { exceptRequestId });
    }
    const rows = await query.getRawMany<{ albumMbid: string }>();
    const songs = await singles.getRawMany<{ singleMbid: string }>();
    return new Set([
      ...rows.map((row) => row.albumMbid),
      ...songs.map((row) => row.singleMbid),
    ]);
  }

  public async updateParentStatus(
    manager: EntityManager,
    entity: MediaRequest
  ): Promise<void> {
    const mediaRepository = manager.getRepository(Media);
    const media = await mediaRepository.findOne({
      where: { id: entity.media.id },
    });
    if (!media) {
      logger.error('Media data not found', {
        label: 'Media Request',
        requestId: entity.id,
        mediaId: entity.media.id,
      });
      return;
    }

    const statusKey = entity.is4k ? 'status4k' : 'status';
    const seasonRequestRepository = manager.getRepository(SeasonRequest);
    const requestRepository = manager.getRepository(MediaRequest);
    // Only unblocklisting changes a blocklisted title's status; request
    // approvals, declines and deletes leave it.
    const blocklisted = media[statusKey] === MediaStatus.BLOCKLISTED;

    if (
      entity.status === MediaRequestStatus.APPROVED &&
      !blocklisted &&
      // Don't downgrade partially available or available media.
      media[statusKey] !== MediaStatus.AVAILABLE &&
      media[statusKey] !== MediaStatus.PARTIALLY_AVAILABLE &&
      media[statusKey] !== MediaStatus.PROCESSING
    ) {
      media[statusKey] = MediaStatus.PROCESSING;
      await mediaRepository.save(media);
    }

    if (
      media.mediaType === MediaType.MOVIE &&
      entity.status === MediaRequestStatus.DECLINED &&
      !blocklisted &&
      media[statusKey] !== MediaStatus.DELETED
    ) {
      media[statusKey] = MediaStatus.UNKNOWN;
      await mediaRepository.save(media);
    }

    // Declining a TV request: only reset if it's the sole pending request and
    // the media is just pending (nothing else approved yet).
    if (
      (media.mediaType === MediaType.TV ||
        media.mediaType === MediaType.MUSIC) &&
      entity.status === MediaRequestStatus.DECLINED &&
      media[statusKey] === MediaStatus.PENDING
    ) {
      const pendingCount = await requestRepository.count({
        where: {
          media: { id: media.id },
          status: MediaRequestStatus.PENDING,
          is4k: entity.is4k,
          id: Not(entity.id),
        },
      });

      if (pendingCount === 0) {
        // Refetch without requests to avoid cascade issues on save.
        const freshMedia = await mediaRepository.findOne({
          where: { id: media.id },
        });
        if (freshMedia) {
          freshMedia[statusKey] = MediaStatus.UNKNOWN;
          await mediaRepository.save(freshMedia);
        }
      }
    }

    if (
      media.mediaType === MediaType.TV &&
      entity.status === MediaRequestStatus.DECLINED
    ) {
      const seasonRepository = manager.getRepository(Season);
      const actualSeasons = await seasonRepository.find({
        where: { media: { id: media.id } },
      });

      for (const seasonRequest of entity.seasons) {
        seasonRequest.status = MediaRequestStatus.DECLINED;
        await seasonRequestRepository.save(seasonRequest);

        const season = actualSeasons.find(
          (s) => s.seasonNumber === seasonRequest.seasonNumber
        );

        if (season && season[statusKey] === MediaStatus.PENDING) {
          const otherActiveRequests = await requestRepository
            .createQueryBuilder('request')
            .leftJoinAndSelect('request.seasons', 'season')
            .where('request.mediaId = :mediaId', { mediaId: media.id })
            .andWhere('request.id != :requestId', { requestId: entity.id })
            .andWhere('request.is4k = :is4k', { is4k: entity.is4k })
            .andWhere('request.status NOT IN (:...statuses)', {
              statuses: [
                MediaRequestStatus.DECLINED,
                MediaRequestStatus.COMPLETED,
              ],
            })
            .andWhere('season.seasonNumber = :seasonNumber', {
              seasonNumber: season.seasonNumber,
            })
            .getCount();

          if (otherActiveRequests === 0) {
            season[statusKey] = MediaStatus.UNKNOWN;
            await seasonRepository.save(season);
          }
        }
      }
    }

    if (
      media.mediaType === MediaType.TV &&
      entity.status === MediaRequestStatus.APPROVED
    ) {
      for (const season of entity.seasons) {
        season.status = MediaRequestStatus.APPROVED;
        await seasonRequestRepository.save(season);
      }
    }

    if (media.mediaType === MediaType.MUSIC) {
      await this.updateMusicAlbums(manager, entity);
    }
  }

  public async handleRemoveParentUpdate(
    manager: EntityManager,
    entity: MediaRequest
  ): Promise<void> {
    const fullMedia = await manager.findOneOrFail(Media, {
      where: { id: entity.media.id },
      relations: {
        requests: { seasons: true, albums: true, songs: true },
        seasons: true,
      },
    });

    const hasActive = fullMedia.requests.some(
      (request) =>
        !request.is4k &&
        request.status !== MediaRequestStatus.COMPLETED &&
        request.status !== MediaRequestStatus.DECLINED
    );
    const hasActive4k = fullMedia.requests.some(
      (request) =>
        request.is4k &&
        request.status !== MediaRequestStatus.COMPLETED &&
        request.status !== MediaRequestStatus.DECLINED
    );

    // A blocklisted title stays blocklisted when its requests are removed.
    const needsStatusUpdate =
      !hasActive &&
      fullMedia.status !== MediaStatus.AVAILABLE &&
      fullMedia.status !== MediaStatus.PARTIALLY_AVAILABLE &&
      fullMedia.status !== MediaStatus.BLOCKLISTED;

    const needs4kStatusUpdate =
      !hasActive4k &&
      fullMedia.status4k !== MediaStatus.AVAILABLE &&
      fullMedia.status4k !== MediaStatus.PARTIALLY_AVAILABLE &&
      fullMedia.status4k !== MediaStatus.BLOCKLISTED;

    if (needsStatusUpdate || needs4kStatusUpdate) {
      // Refetch without requests to avoid cascade issues on save.
      const cleanMedia = await manager.findOneOrFail(Media, {
        where: { id: entity.media.id },
      });

      if (needsStatusUpdate) {
        const hadCompleted = fullMedia.requests.some(
          (r) => !r.is4k && r.status === MediaRequestStatus.COMPLETED
        );
        cleanMedia.status = hadCompleted
          ? MediaStatus.DELETED
          : MediaStatus.UNKNOWN;
      }

      if (needs4kStatusUpdate) {
        const hadCompleted4k = fullMedia.requests.some(
          (r) => r.is4k && r.status === MediaRequestStatus.COMPLETED
        );
        cleanMedia.status4k = hadCompleted4k
          ? MediaStatus.DELETED
          : MediaStatus.UNKNOWN;
      }

      await manager.save(cleanMedia);
    }

    // Reset stale seasons, or re-requests fail with "No seasons available to
    // request".
    if (fullMedia.mediaType === MediaType.TV) {
      const statusKey = entity.is4k ? 'status4k' : 'status';
      const removedSeasonNumbers = new Set(
        entity.seasons.map((s) => s.seasonNumber)
      );
      const activeSeasonNumbers = new Set(
        fullMedia.requests
          .filter(
            (request) =>
              request.is4k === entity.is4k &&
              request.status !== MediaRequestStatus.COMPLETED &&
              request.status !== MediaRequestStatus.DECLINED
          )
          .flatMap((request) => request.seasons.map((s) => s.seasonNumber))
      );

      const changedSeasons: Season[] = [];
      for (const season of fullMedia.seasons) {
        if (
          (season[statusKey] === MediaStatus.PENDING ||
            season[statusKey] === MediaStatus.PROCESSING) &&
          removedSeasonNumbers.has(season.seasonNumber) &&
          !activeSeasonNumbers.has(season.seasonNumber)
        ) {
          season[statusKey] = MediaStatus.UNKNOWN;
          changedSeasons.push(season);
        }
      }
      if (changedSeasons.length) {
        await manager.save(changedSeasons);
      }
    }

    // Albums only this request wanted revert to unrequested so they can be
    // requested again. Lidarr is left untouched.
    if (fullMedia.mediaType === MediaType.MUSIC) {
      const removed = lidarrTargets(entity).map((target) => target.mbId);
      const stillWanted = new Set(
        fullMedia.requests
          .filter(
            (request) =>
              request.status !== MediaRequestStatus.COMPLETED &&
              request.status !== MediaRequestStatus.DECLINED
          )
          .flatMap((request) =>
            lidarrTargets(request).map((target) => target.mbId)
          )
      );
      const free = removed.filter((id) => !stillWanted.has(id));
      if (free.length) {
        await manager.getRepository(MusicAlbum).update(
          {
            mediaId: fullMedia.id,
            mbId: In(free),
            status: In([MediaStatus.PENDING, MediaStatus.PROCESSING]),
          },
          { status: MediaStatus.UNKNOWN }
        );
      }
    }
  }

  /**
   * Records a request's history on its title: the request and each status
   * change. Written through the save's own connection.
   */
  private async recordRequestHistory(
    request: MediaRequest,
    previousStatus: MediaRequestStatus | undefined,
    manager: EntityManager
  ): Promise<void> {
    let media = request.media;

    if (!media?.tmdbId && !media?.foreignId && request.id) {
      media = (
        await manager.findOne(MediaRequest, {
          where: { id: request.id },
          relations: { media: true },
        })
      )?.media as Media;
    }

    // Films and series by TMDB id; music by the artist's id.
    if (!media?.tmdbId && !media?.foreignId) {
      return;
    }

    const base = {
      tmdbId: media.tmdbId,
      foreignId: media.foreignId,
      mediaType: media.mediaType,
      is4k: !!request.is4k,
    };

    if (previousStatus === undefined) {
      const seasons = [...(request.seasons ?? [])].sort(
        (a, b) => a.seasonNumber - b.seasonNumber
      );
      const albums = [...(request.albums ?? [])].sort((a, b) => a.id - b.id);
      const songs = [...(request.songs ?? [])].sort((a, b) => a.id - b.id);
      const scope =
        albums.length || songs.length
          ? musicScope(
              albums.map((album) => album.title),
              songs.map((song) =>
                song.version ? `${song.title} (${song.version})` : song.title
              )
            )
          : seasons.length === 1 && seasons[0].episodes?.length
            ? `Season ${seasons[0].seasonNumber}, ${
                seasons[0].episodes.length === 1 ? 'episode' : 'episodes'
              } ${seasons[0].episodes
                .map((episode) => episode.episodeNumber)
                .sort((a, b) => a - b)
                .join(', ')}`
            : seasons.length
              ? `${seasons.length === 1 ? 'Season' : 'Seasons'} ${seasons
                  .map((season) => season.seasonNumber)
                  .join(', ')}`
              : undefined;

      await recordMediaEvent(
        {
          ...base,
          type: MediaEventType.REQUESTED,
          userId: request.requestedBy?.id,
          detail: scope,
        },
        manager
      );

      if (request.status === MediaRequestStatus.APPROVED) {
        await recordMediaEvent(
          {
            ...base,
            type: MediaEventType.APPROVED,
            userId: request.modifiedBy?.id,
            detail: 'Automatically',
          },
          manager
        );
      }
      return;
    }

    if (previousStatus === request.status) {
      return;
    }

    const type = {
      [MediaRequestStatus.APPROVED]: MediaEventType.APPROVED,
      [MediaRequestStatus.DECLINED]: MediaEventType.DECLINED,
      [MediaRequestStatus.FAILED]: MediaEventType.FAILED,
    }[request.status as number];

    if (type) {
      await recordMediaEvent(
        {
          ...base,
          type,
          userId:
            type === MediaEventType.FAILED ? null : request.modifiedBy?.id,
          // The decline reason when given, or the retry's new server. Only on
          // approval, since sending on can still fail within the same save.
          detail:
            type === MediaEventType.DECLINED
              ? request.declineReason || undefined
              : type === MediaEventType.APPROVED
                ? request.historyNote
                : undefined,
        },
        manager
      );
    }
  }

  public async afterUpdate(event: UpdateEvent<MediaRequest>): Promise<void> {
    if (!event.entity) {
      return;
    }

    const previousStatus = (event.databaseEntity as MediaRequest | undefined)
      ?.status;

    await this.recordRequestHistory(
      event.entity as MediaRequest,
      previousStatus ?? (event.entity as MediaRequest).status,
      event.manager
    );

    // Dispatch and media status follow only a status change. Other saves must
    // not resend an approved request (a fresh search) or reset its title. A
    // plain update() carries only its columns and nothing to compare against,
    // so it's ignored too.
    const statusChanged =
      previousStatus !== undefined && previousStatus !== event.entity.status;

    if (statusChanged) {
      try {
        await this.sendToRadarr(event.entity as MediaRequest, event.manager);
        await this.sendToSonarr(event.entity as MediaRequest, event.manager);
        await this.sendToLidarr(event.entity as MediaRequest, event.manager);
      } catch (e) {
        logger.error('Error while sending to *arr in afterUpdate subscriber', {
          label: 'Media Request',
          requestId: (event.entity as MediaRequest).id,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }

    try {
      if (statusChanged) {
        await withNestedTransaction(event.manager, async (manager) => {
          await this.updateParentStatus(manager, event.entity as MediaRequest);
        });
      }

      // A plain update() of the status has no media loaded; its caller handles
      // the follow-up (music completion does).
      if (event.entity.status === MediaRequestStatus.COMPLETED) {
        if (event.entity.media?.mediaType === MediaType.MOVIE) {
          await this.notifyAvailableMovie(event.entity as MediaRequest, event);
        }
        if (event.entity.media?.mediaType === MediaType.TV) {
          await this.notifyAvailableSeries(event.entity as MediaRequest, event);
        }
        if (event.entity.media?.mediaType === MediaType.MUSIC) {
          await notifyAvailableMusic(event.entity as MediaRequest);
        }
      }
    } catch (e) {
      logger.error(
        'Error while updating parent status in afterUpdate subscriber',
        {
          label: 'Media Request',
          requestId: (event.entity as MediaRequest).id,
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );
    }
  }

  public async afterInsert(event: InsertEvent<MediaRequest>): Promise<void> {
    if (!event.entity) {
      return;
    }

    await this.recordRequestHistory(event.entity, undefined, event.manager);

    try {
      await this.sendToRadarr(event.entity as MediaRequest, event.manager);
      await this.sendToSonarr(event.entity as MediaRequest, event.manager);
      await this.sendToLidarr(event.entity as MediaRequest, event.manager);
    } catch (e) {
      logger.error('Error while sending to *arr in afterInsert subscriber', {
        label: 'Media Request',
        requestId: (event.entity as MediaRequest).id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }

    try {
      await withNestedTransaction(event.manager, async (manager) => {
        await this.updateParentStatus(manager, event.entity as MediaRequest);
      });
    } catch (e) {
      logger.error(
        'Error while updating parent status in afterInsert subscriber',
        {
          label: 'Media Request',
          requestId: (event.entity as MediaRequest).id,
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );
    }
  }

  public async beforeRemove(event: RemoveEvent<MediaRequest>): Promise<void> {
    const entity = (event.databaseEntity ?? event.entity) as
      | MediaRequest
      | undefined;

    if (!entity?.id || entity.type !== MediaType.TV) {
      return;
    }

    // Use the removal's connection: on Postgres a request created and removed
    // in one transaction is invisible to the global one, and its Sonarr
    // clean-up would be skipped.
    const seasons = await event.manager.getRepository(SeasonRequest).find({
      where: { request: { id: entity.id } },
    });

    // databaseEntity has no relations loaded, so resolve the media id
    // explicitly.
    let mediaId: number | undefined = entity.media?.id;

    if (mediaId === undefined) {
      const row = await event.manager.getRepository(MediaRequest).findOne({
        where: { id: entity.id },
        relations: { media: true },
      });

      mediaId = row?.media?.id;
    }

    if (mediaId === undefined) {
      return;
    }

    pendingRemovals.set(entity.id, {
      mediaId: mediaId as number,
      is4k: entity.is4k,
      serverId: entity.serverId ?? null,
      seasonNumbers: [...new Set(seasons.map((s) => s.seasonNumber))],
    });
  }

  public async afterRemove(event: RemoveEvent<MediaRequest>): Promise<void> {
    if (!event.entity) {
      return;
    }

    await this.handleRemoveParentUpdate(
      event.manager as EntityManager,
      event.entity as MediaRequest
    );

    // TypeORM clears the removed entity's primary key, so take the id from the
    // database copy.
    const removedId =
      (event.databaseEntity as MediaRequest | undefined)?.id ??
      (event.entity as MediaRequest).id;
    const context =
      removedId !== undefined ? pendingRemovals.get(removedId) : undefined;

    if (context && removedId !== undefined) {
      pendingRemovals.delete(removedId);
      await reconcileMonitoringAfterRemoval(
        context,
        removedId,
        event.manager as EntityManager
      );
    }
  }

  public listenTo(): typeof MediaRequest {
    return MediaRequest;
  }
}
