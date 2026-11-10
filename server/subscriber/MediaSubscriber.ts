import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { MediaEventType, recordMediaEvent } from '@server/lib/mediaHistory';
import logger from '@server/logger';
import { withNestedTransaction } from '@server/utils/nestedTransaction';
import type {
  EntityManager,
  EntitySubscriberInterface,
  UpdateEvent,
} from 'typeorm';
import { EventSubscriber, In } from 'typeorm';

@EventSubscriber()
export class MediaSubscriber implements EntitySubscriberInterface<Media> {
  private async updateRelatedMediaRequest(
    manager: EntityManager,
    event: Media,
    databaseEvent: Media,
    is4k: boolean
  ) {
    // Music requests are completed per album by the music scans
    // (lib/music/completion), not from the artist's status.
    if (event.mediaType === MediaType.MUSIC) {
      return;
    }
    const requestRepository = manager.getRepository(MediaRequest);
    const seasonRequestRepository = manager.getRepository(SeasonRequest);

    const relatedRequests = await requestRepository.find({
      relations: {
        media: true,
      },
      where: {
        media: { id: event.id },
        // Pending ones too: a title that turns up (added by hand, or marked
        // available) completes them. Approving them instead would send them
        // to Radarr or Sonarr and download it again.
        status: In([
          MediaRequestStatus.PENDING,
          MediaRequestStatus.APPROVED,
          MediaRequestStatus.FAILED,
        ]),
        is4k,
      },
    });

    // Complete related requests when the media is available or deleted.
    if (relatedRequests.length > 0) {
      const completedRequests: MediaRequest[] = [];

      for (const request of relatedRequests) {
        let shouldComplete = false;

        // Only availability completes a pending request; a deleted title
        // leaves it waiting.
        const pending = request.status === MediaRequestStatus.PENDING;
        if (
          (event[request.is4k ? 'status4k' : 'status'] ===
            MediaStatus.AVAILABLE ||
            (!pending &&
              event[request.is4k ? 'status4k' : 'status'] ===
                MediaStatus.DELETED)) &&
          event.mediaType === MediaType.MOVIE
        ) {
          shouldComplete = true;
        } else if (event.mediaType === 'tv') {
          const allSeasonResults: boolean[] = [];

          // Sequential: these saves share the transaction's connection.
          for (const requestSeason of request.seasons) {
            const matchingSeason = event.seasons.find(
              (mediaSeason) =>
                mediaSeason.seasonNumber === requestSeason.seasonNumber
            );
            const matchingOldSeason = databaseEvent.seasons.find(
              (oldSeason) =>
                oldSeason.seasonNumber === requestSeason.seasonNumber
            );

            if (!matchingSeason) {
              allSeasonResults.push(false);
              continue;
            }

            const currentSeasonStatus =
              matchingSeason[request.is4k ? 'status4k' : 'status'];
            const previousSeasonStatus =
              matchingOldSeason?.[request.is4k ? 'status4k' : 'status'];

            const hasStatusChanged =
              currentSeasonStatus !== previousSeasonStatus;

            const shouldUpdate =
              (hasStatusChanged ||
                requestSeason.status === MediaRequestStatus.COMPLETED) &&
              (currentSeasonStatus === MediaStatus.AVAILABLE ||
                (!pending && currentSeasonStatus === MediaStatus.DELETED));

            if (shouldUpdate) {
              requestSeason.status = MediaRequestStatus.COMPLETED;
              await seasonRequestRepository.save(requestSeason);

              allSeasonResults.push(true);
              continue;
            }

            allSeasonResults.push(false);
          }

          const allSeasonsReady = allSeasonResults.every((result) => result);
          shouldComplete = allSeasonsReady;
        }

        if (shouldComplete) {
          request.status = MediaRequestStatus.COMPLETED;
          completedRequests.push(request);
        }
      }

      // One at a time: saving together runs every request's afterUpdate
      // concurrently on this connection, and on Postgres their savepoints undo
      // each other, aborting the scan's save and losing the "available"
      // notifications.
      for (const request of completedRequests) {
        await requestRepository.save(request);
      }
    }
  }

  public async beforeUpdate(event: UpdateEvent<Media>): Promise<void> {
    if (!event.entity || !event.databaseEntity) {
      return;
    }

    // Load seasons into databaseEntity for seasonStatusCheck in afterUpdate.
    const seasons = await event.manager
      .getRepository(Season)
      .createQueryBuilder('season')
      .leftJoin('season.media', 'media')
      .where('media.id = :id', { id: event.databaseEntity.id })
      .getMany();

    event.databaseEntity.seasons = seasons;
  }

  public async afterUpdate(event: UpdateEvent<Media>): Promise<void> {
    if (!event.entity || !event.databaseEntity) {
      return;
    }

    // Record status changes in the title's history: processing, available, or
    // removed. Blocklisting is recorded where it happens, with who and why.
    const statusEvents: Partial<Record<MediaStatus, MediaEventType>> = {
      [MediaStatus.PROCESSING]: MediaEventType.PROCESSING,
      [MediaStatus.PARTIALLY_AVAILABLE]: MediaEventType.PARTIALLY_AVAILABLE,
      [MediaStatus.AVAILABLE]: MediaEventType.AVAILABLE,
      [MediaStatus.DELETED]: MediaEventType.REMOVED,
    };
    for (const is4k of [false, true]) {
      const key = is4k ? 'status4k' : 'status';
      const before = (event.databaseEntity as Media)[key];
      const after = (event.entity as Media)[key];
      const type = after !== before ? statusEvents[after] : undefined;
      const tmdbId =
        (event.entity as Media).tmdbId ??
        (event.databaseEntity as Media).tmdbId;
      // Music is keyed by the artist's MusicBrainz id (its tmdbId is 0).
      const foreignId =
        (event.entity as Media).foreignId ??
        (event.databaseEntity as Media).foreignId;
      if (type && (tmdbId || foreignId)) {
        await recordMediaEvent(
          {
            tmdbId,
            foreignId,
            mediaType:
              (event.entity as Media).mediaType ??
              (event.databaseEntity as Media).mediaType,
            type,
            is4k,
          },
          event.manager
        );
      }
    }

    const validStatuses = [
      MediaStatus.PARTIALLY_AVAILABLE,
      MediaStatus.AVAILABLE,
      MediaStatus.DELETED,
    ];

    const seasonStatusCheck = (is4k: boolean) => {
      return event.entity?.seasons?.some((season: Season, index: number) => {
        const previousSeason = event.databaseEntity.seasons[index];

        return (
          season[is4k ? 'status4k' : 'status'] !==
          previousSeason?.[is4k ? 'status4k' : 'status']
        );
      });
    };

    try {
      if (
        (event.entity.status !== event.databaseEntity?.status ||
          (event.entity.mediaType === MediaType.TV &&
            seasonStatusCheck(false))) &&
        validStatuses.includes(event.entity.status)
      ) {
        await withNestedTransaction(event.manager, async (manager) => {
          await this.updateRelatedMediaRequest(
            manager,
            event.entity as Media,
            event.databaseEntity as Media,
            false
          );
        });
      }
    } catch (e) {
      logger.error(
        'Error while updating related requests in afterUpdate subscriber',
        {
          label: 'Media',
          mediaId: event.entity.id,
          is4k: false,
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );
    }

    try {
      if (
        (event.entity.status4k !== event.databaseEntity?.status4k ||
          (event.entity.mediaType === MediaType.TV &&
            seasonStatusCheck(true))) &&
        validStatuses.includes(event.entity.status4k)
      ) {
        await withNestedTransaction(event.manager, async (manager) => {
          await this.updateRelatedMediaRequest(
            manager,
            event.entity as Media,
            event.databaseEntity as Media,
            true
          );
        });
      }
    } catch (e) {
      logger.error(
        'Error while updating related requests in afterUpdate subscriber',
        {
          label: 'Media',
          mediaId: event.entity.id,
          is4k: true,
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );
    }
  }

  public listenTo(): typeof Media {
    return Media;
  }
}
