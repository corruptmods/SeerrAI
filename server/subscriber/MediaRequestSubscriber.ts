import type LidarrAPI from '@server/api/servarr/lidarr';
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
import type { User } from '@server/entity/User';
import { MediaEventType, recordMediaEvent } from '@server/lib/mediaHistory';
import { lidarrApi } from '@server/lib/music/access';
import { notifyAvailableMusic } from '@server/lib/music/completion';
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
  describeServerIssue,
  requestServerIssue,
} from '@server/lib/requestServers';
import { resolveSeasonMonitorTarget } from '@server/lib/seasonMonitorTarget';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { sonarrRouting } from '@server/lib/sonarrRouting';
import logger from '@server/logger';
import { withNestedTransaction } from '@server/utils/nestedTransaction';
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

/** Lidarr could not look something up yet; trying again later may work. */
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
 * Which albums a music request asked for, as its history says it: the
 * album's title, or how many and the first few.
 */
const albumScope = (titles: string[]): string | undefined => {
  if (!titles.length) {
    return undefined;
  }
  if (titles.length === 1) {
    return titles[0];
  }
  const shown = titles.slice(0, 3).join(', ');
  return `${titles.length} albums: ${shown}${titles.length > 3 ? '…' : ''}`;
};

/**
 * A watcher's copy of an availability notification: for them alone, about
 * the request as it is. The channels and admins hear once, from the
 * requester's copy, not once more for every watcher.
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
 * Reconciles Sonarr's episode monitoring for every season this request
 * touches, against the union of all live requests for the same series.
 *
 * Episodes nobody asked for are unmonitored, so a request for two episodes
 * really does mean two episodes. Episodes anyone asked for stay monitored,
 * so a second user's request never cancels the first one's.
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

        // Only chase episodes that are wanted and not already on disk.
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
    // Visible on the title, not only in the log: Sonarr may now download the
    // whole season, or never search the episodes that were asked for.
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

/**
 * Re-reconciles Sonarr monitoring after a request is removed.
 *
 * Without this, deleting a request leaves Sonarr monitoring episodes nobody
 * asked for. The reconcile is against the union of whatever requests remain,
 * so removing one user's request never cancels another user's episodes.
 *
 * Skipped when the media row itself is gone: that is the removal-tool path
 * (Maintainerr deleting a whole show), where the series is being taken out
 * entirely and there is nothing left to monitor for.
 */
interface RemovalContext {
  mediaId: number;
  is4k: boolean;
  serverId: number | null;
  seasonNumbers: number[];
}

// By afterRemove the season relations are already cleared by the cascade, so
// the details needed to reconcile are captured in beforeRemove.
const pendingRemovals = new Map<number, RemovalContext>();

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
    // Visible on the title: Sonarr may keep monitoring, and downloading,
    // episodes nobody wants any more.
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
 * Music requests waiting to go to Lidarr until the save that approved them
 * has committed, by the database connection that save runs on.
 */
const lidarrSendsAfterCommit = new WeakMap<QueryRunner, (() => void)[]>();

@EventSubscriber()
export class MediaRequestSubscriber implements EntitySubscriberInterface<MediaRequest> {
  /**
   * A blocklisted title is never sent to Radarr or Sonarr, whatever state a
   * request for it is in: one approved from before the blocklist would
   * otherwise bring it straight back.
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
    // Get fresh media state using event manager
    let latestMedia: Media | null = null;
    if (event?.manager) {
      latestMedia = await event.manager.findOne(Media, {
        where: { id: entity.media.id },
      });
    }
    if (!latestMedia) {
      const mediaRepository = getRepository(Media);
      latestMedia = await mediaRepository.findOne({
        where: { id: entity.media.id },
      });
    }

    // Check availability using fresh media state
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
    // Get fresh media state with seasons using event manager
    let latestMedia: Media | null = null;
    if (event?.manager) {
      latestMedia = await event.manager.findOne(Media, {
        where: { id: entity.media.id },
        relations: { seasons: true },
      });
    }
    if (!latestMedia) {
      const mediaRepository = getRepository(Media);
      latestMedia = await mediaRepository.findOne({
        where: { id: entity.media.id },
        relations: { seasons: true },
      });
    }

    if (!latestMedia) {
      return;
    }

    // Check availability using fresh media state
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
        // No Radarr at all is a choice (requests fulfilled by hand): the
        // request stays approved.
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

        // Its server was removed, or none is the default: failed, saying
        // which, rather than left approved with nothing ever sent.
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
          radarrSettings = settings.radarr.find(
            (radarr) => radarr.id === entity.serverId
          );
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
          const radarrTags = await radarr.getTags();
          // old tags had space around the hyphen
          let userTag = radarrTags.find((v) =>
            v.label.startsWith(entity.requestedBy.id + ' - ')
          );
          // new tags do not have spaces around the hyphen, since spaces are not allowed anymore
          if (!userTag) {
            userTag = radarrTags.find((v) =>
              v.label.startsWith(entity.requestedBy.id + '-')
            );
          }
          if (!userTag) {
            logger.info(`Requester has no active tag. Creating new`, {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              userId: entity.requestedBy.id,
              newTag:
                entity.requestedBy.id +
                '-' +
                sanitizeDisplayName(entity.requestedBy.displayName),
            });
            userTag = await radarr.createTag({
              label:
                entity.requestedBy.id +
                '-' +
                sanitizeDisplayName(entity.requestedBy.displayName),
            });
          }
          if (userTag.id) {
            if (!tags?.find((v) => v === userTag?.id)) {
              tags?.push(userTag.id);
            }
          } else {
            logger.warn(`Requester has no tag and failed to add one`, {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              userId: entity.requestedBy.id,
              radarrServer: radarrSettings.hostname + ':' + radarrSettings.port,
            });
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

        // Run entity asynchronously so we don't wait for it on the UI side
        radarr
          .addMovie(radarrMovieOptions)
          .then(async (radarrMovie) => {
            // Needs its own repository as this runs detached from the request transaction
            const mediaRepository = getRepository(Media);
            // We grab media again here to make sure we have the latest version of it
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
          sonarrSettings = settings.sonarr.find(
            (sonarr) => sonarr.id === entity.serverId
          );
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
          /*
           * Upstream deleted the media row and the request here. That left
           * no trace of the attempt, so watchlist sync saw the title as
           * never requested and tried again on every run — each time
           * inserting, notifying, and deleting again. It happened with
           * "HOLLOWAY - Phantom" once TVDB folded it into the Phantom
           * anthology, leaving the TMDB entry without a TVDB id of its own.
           *
           * Keep both and mark the request failed instead. The failure is
           * visible to an admin, the duplicate guard sees the existing
           * auto-request, and the loop stops.
           */
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
          const sonarrTags = await sonarr.getTags();
          // old tags had space around the hyphen
          let userTag = sonarrTags.find((v) =>
            v.label.startsWith(entity.requestedBy.id + ' - ')
          );
          // new tags do not have spaces around the hyphen, since spaces are not allowed anymore
          if (!userTag) {
            userTag = sonarrTags.find((v) =>
              v.label.startsWith(entity.requestedBy.id + '-')
            );
          }
          if (!userTag) {
            logger.info(`Requester has no active tag. Creating new`, {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              userId: entity.requestedBy.id,
              newTag:
                entity.requestedBy.id +
                '-' +
                sanitizeDisplayName(entity.requestedBy.displayName),
            });
            userTag = await sonarr.createTag({
              label:
                entity.requestedBy.id +
                '-' +
                sanitizeDisplayName(entity.requestedBy.displayName),
            });
          }
          if (userTag.id) {
            if (!tags?.find((v) => v === userTag?.id)) {
              tags?.push(userTag.id);
            }
          } else {
            logger.warn(`Requester has no tag and failed to add one`, {
              label: 'Media Request',
              requestId: entity.id,
              mediaId: entity.media.id,
              userId: entity.requestedBy.id,
              sonarrServer: sonarrSettings.hostname + ':' + sonarrSettings.port,
            });
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

        // Run entity asynchronously so we don't wait for it on the UI side
        sonarr
          .addSeries(sonarrSeriesOptions)
          .then(async (sonarrSeries) => {
            // Needs its own repository as this runs detached from the request transaction
            const mediaRepository = getRepository(Media);
            // We grab media again here to make sure we have the latest version of it
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
   * Sends an approved music request to Lidarr. Which Lidarr is decided here,
   * in the request's own save; talking to Lidarr then happens behind it,
   * once that save has committed (dispatchToLidarr), so approving does not
   * wait on Lidarr and its metadata service.
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
    if (await this.titleBlocklisted(entity, manager)) {
      return;
    }

    const settings = getSettings();
    // As for Radarr and Sonarr: no Lidarr at all leaves it approved.
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

    // Never rejects: a failure marks the request failed and says why.
    const send = () => void this.dispatchToLidarr(entity, lidarrSettings);

    // Sent once the request's own save has committed. Started inside it, a
    // quick failure was written on another connection that could not see
    // the new request yet (on Postgres), so the request stayed approved
    // while "failed" went out to people.
    const queryRunner = manager.queryRunner;
    if (!queryRunner?.isTransactionActive) {
      send();
      return;
    }
    const waiting = lidarrSendsAfterCommit.get(queryRunner) ?? [];
    waiting.push(() => {
      // Unless that save was undone, or the request changed since.
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
    // Releasing a savepoint inside the transaction is not its commit.
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
   * The Lidarr half of sendToLidarr. Lidarr is only ever told to monitor
   * and search for what was asked: nothing is unmonitored, and an artist
   * Lidarr already has keeps its folder, profiles and new-release setting,
   * so one request never undoes another.
   *
   * - An artist Lidarr does not have, for one album: the album is added
   *   with the artist set up around it, nothing else of theirs monitored.
   * - For several albums: the artist is added with exactly those albums to
   *   monitor (Lidarr's albumsToMonitor, which leaves every other album
   *   unmonitored, so it is only used for a new artist).
   * - An artist Lidarr has: the albums it has are monitored, the ones it
   *   lacks are added, the artist is monitored if it was not, and the
   *   albums it had are searched for.
   */
  public async dispatchToLidarr(
    entity: MediaRequest,
    lidarrSettings: LidarrSettings
  ): Promise<void> {
    const lidarr = lidarrApi(lidarrSettings);
    const search = !lidarrSettings.preventSearch;
    const wanted = [...(entity.albums ?? [])]
      .sort((a, b) => a.id - b.id)
      .map((album) => album.albumMbid);
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
        ? await this.lidarrRequesterTag(lidarr, entity)
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
            addOptions: { monitor: 'none', searchForMissingAlbums: false },
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
        // Albums outside the metadata profile are not listed yet; music
        // sync adds them once Lidarr has refreshed the artist.
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
            artist: { id: artist.id },
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
      const reason =
        e instanceof LidarrLookupError
          ? e.message
          : `Lidarr could not take the request: ${
              e instanceof Error ? e.message : String(e)
            }`;
      await markUndispatchable(entity, reason);

      if (
        media &&
        entity.status === MediaRequestStatus.FAILED &&
        (await claimDelivery(entity.id, Notification.MEDIA_FAILED))
      ) {
        MediaRequest.sendNotification(entity, media, Notification.MEDIA_FAILED);
      }
    }
  }

  /** The requester's tag in Lidarr ("12-alex"), made if it is not there. */
  private async lidarrRequesterTag(
    lidarr: LidarrAPI,
    entity: MediaRequest
  ): Promise<number | undefined> {
    const label = `${entity.requestedBy.id}-${sanitizeDisplayName(
      entity.requestedBy.displayName
    )}`;
    const existing = (await lidarr.getTags()).find(
      (tag) =>
        tag.label.startsWith(`${entity.requestedBy.id} - `) ||
        tag.label.startsWith(`${entity.requestedBy.id}-`)
    );
    return (existing ?? (await lidarr.createTag({ label }))).id;
  }

  /**
   * An approved or declined music request's albums: approved ones are on
   * their way, declined ones go back to nobody having asked, unless another
   * request still waits for them.
   */
  private async updateMusicAlbums(
    manager: EntityManager,
    entity: MediaRequest
  ): Promise<void> {
    const albums = entity.albums ?? [];
    if (!albums.length) {
      return;
    }
    const albumRequests = manager.getRepository(AlbumRequest);
    const musicAlbums = manager.getRepository(MusicAlbum);
    const mbIds = albums.map((album) => album.albumMbid);

    if (entity.status === MediaRequestStatus.APPROVED) {
      await albumRequests.update(
        { id: In(albums.map((album) => album.id)) },
        { status: MediaRequestStatus.APPROVED }
      );
      albums.forEach((album) => (album.status = MediaRequestStatus.APPROVED));
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
      await albumRequests.update(
        { id: In(albums.map((album) => album.id)) },
        { status: MediaRequestStatus.DECLINED }
      );
      albums.forEach((album) => (album.status = MediaRequestStatus.DECLINED));
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

  /** Albums another open request for the artist is waiting for. */
  private async albumsStillWanted(
    manager: EntityManager,
    mediaId: number,
    exceptRequestId?: number
  ): Promise<Set<string>> {
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
    return new Set(rows.map((row) => row.albumMbid));
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
    // Only taking it off the blocklist changes a blocklisted title's status:
    // approving, declining or deleting a request for it leaves it there.
    const blocklisted = media[statusKey] === MediaStatus.BLOCKLISTED;

    if (
      entity.status === MediaRequestStatus.APPROVED &&
      !blocklisted &&
      // Do not update the status if the item is already partially available or available
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

    /**
     * If the media type is TV, and we are declining a request,
     * we must check if its the only pending request and that
     * there the current media status is just pending (meaning no
     * other requests have yet to be approved)
     */
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
        // Re-fetch media without requests to avoid cascade issues
        const freshMedia = await mediaRepository.findOne({
          where: { id: media.id },
        });
        if (freshMedia) {
          freshMedia[statusKey] = MediaStatus.UNKNOWN;
          await mediaRepository.save(freshMedia);
        }
      }
    }

    // Reset season statuses when a TV request is declined
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

    // Approve child seasons if parent is approved
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
      relations: { requests: { seasons: true, albums: true }, seasons: true },
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

    // A blocklisted title stays blocklisted when its requests go.
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
      // Re-fetch WITHOUT requests to avoid cascade issues on save
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

    // Reset stale seasons or re-requests fail ("No seasons available to request")
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

    // Albums only this request was waiting for go back to nobody having
    // asked, so they can be requested again. Lidarr is left as it is.
    if (fullMedia.mediaType === MediaType.MUSIC) {
      const removed = (entity.albums ?? []).map((album) => album.albumMbid);
      const stillWanted = new Set(
        fullMedia.requests
          .filter(
            (request) =>
              request.status !== MediaRequestStatus.COMPLETED &&
              request.status !== MediaRequestStatus.DECLINED
          )
          .flatMap((request) =>
            (request.albums ?? []).map((album) => album.albumMbid)
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
   * A request's part of its title's history: that it was asked for, and each
   * change of status. Written through the save's own connection.
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

    // Films and series by their TMDB id; music by the artist's own.
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
      const scope = albums.length
        ? albumScope(albums.map((album) => album.title))
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
          // Why it was declined, when whoever declined it said; where a
          // retry sent it, when it went to another server. Only on the
          // approval: sending it on can fail within the same save.
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

    // Sending on and the title's status follow a change of status. A save
    // that changed something else must not send an approved request to
    // Radarr or Sonarr again (a fresh search), or reset its title. A plain
    // update() of a few columns arrives with only those columns and nothing
    // to compare against, and is not a request to act on either.
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

      // A plain update() of the status arrives without the request's
      // media: whatever made it says so itself (music's completion does).
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

    // Through the removal's own connection: a request created and removed in
    // one transaction is invisible to the global one on Postgres, and its
    // Sonarr clean-up would be skipped.
    const seasons = await event.manager.getRepository(SeasonRequest).find({
      where: { request: { id: entity.id } },
    });

    // databaseEntity is a bare row with no relations loaded, so the media id
    // has to be resolved explicitly rather than read off the relation.
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

    // TypeORM clears the primary key on the removed entity, so the id has to
    // come from the database copy captured before the delete.
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
