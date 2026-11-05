import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
  VIDEO_MEDIA_TYPES,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Episode from '@server/entity/Episode';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import { NotificationDelivery } from '@server/entity/NotificationDelivery';
import { tellLeavingSoon } from '@server/lib/leavingSoonNotices';
import { musicRequestAvailable } from '@server/lib/music/completion';
import {
  claimDelivery,
  hasDelivery,
  notifyRequestWatchers,
  releaseDelivery,
} from '@server/lib/notificationDelivery';
import { Notification } from '@server/lib/notifications';
import type { NotificationEvent } from '@server/lib/notifications/eventTitles';
import { seriesReadyToWatchEvent } from '@server/lib/notifications/eventTitles';
import {
  notifyPlaylistFailures,
  playlistOfRequests,
} from '@server/lib/playlists/failureNotices';
import logger from '@server/logger';
import { In } from 'typeorm';

const isRequestAvailable = async (
  request: MediaRequest,
  media: Media
): Promise<boolean> => {
  const statusKey = request.is4k ? 'status4k' : 'status';

  // Music: every requested album is here.
  if (request.type === MediaType.MUSIC) {
    return musicRequestAvailable(
      request,
      await getRepository(MusicAlbum).find({
        select: { id: true, mbId: true, status: true },
        where: { mediaId: media.id },
      })
    );
  }

  if (request.type === MediaType.MOVIE) {
    return media[statusKey] === MediaStatus.AVAILABLE;
  }

  const requestedSeasons = request.seasons.map((season) => season.seasonNumber);

  if (!requestedSeasons.length) {
    return false;
  }

  return requestedSeasons.every((seasonNumber) =>
    media.seasons.some(
      (season) =>
        season.seasonNumber === seasonNumber &&
        season[statusKey] === MediaStatus.AVAILABLE
    )
  );
};

/**
 * Delivers one request without letting its failure abort the rest of the pass.
 */
const deliverSafely = async (
  request: MediaRequest,
  media: Media,
  type: Notification,
  episodeKey = '',
  eventOverride?: NotificationEvent,
  extraFields?: { name: string; value: string }[]
): Promise<void> => {
  try {
    await deliver(request, media, type, episodeKey, eventOverride, extraFields);
  } catch (e) {
    logger.error('Could not reconcile a notification for one request', {
      label: 'Notifications',
      requestId: request.id,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
};

/**
 * One claim per request, so the caught-up moment is announced exactly once
 * however many episodes air afterwards.
 */
const CAUGHT_UP_CLAIM_KEY = 'caught-up';

const deliver = async (
  request: MediaRequest,
  media: Media,
  type: Notification,
  episodeKey = '',
  eventOverride?: NotificationEvent,
  extraFields?: { name: string; value: string }[]
): Promise<void> => {
  const claimed = await claimDelivery(request.id, type, 0, episodeKey);

  if (!claimed) {
    return;
  }

  const sent = await MediaRequest.sendNotification(
    request,
    media,
    type,
    eventOverride,
    extraFields
  );

  // The subscriber notifies watchers itself, so when this path catches a
  // missed notification it must too, or they never hear. Each gets their own
  // copy in the same words about the request as it is, not one posing as
  // theirs, which skipped them when the requester had muted it and told the
  // channels the watcher had requested it.
  if (sent && type === Notification.MEDIA_AVAILABLE) {
    await notifyRequestWatchers(
      request.id,
      (watcher) =>
        MediaRequest.sendNotification(
          request,
          media,
          type,
          eventOverride,
          extraFields,
          watcher
        ),
      episodeKey
    );
  }

  if (!sent) {
    // sendNotification already logged the failure. Release the exact claim
    // taken above, with its episode key, so the next pass can retry.
    await releaseDelivery(request.id, type, 0, episodeKey);

    logger.warn('Released notification claim after failed send', {
      label: 'Notifications',
      requestId: request.id,
      type: Notification[type],
    });
  }
};

/**
 * Requests in the given status with no delivery row for the notification type.
 * Filtering in the query keeps each pass proportional to outstanding
 * notifications, not request history.
 */
const findUnclaimedRequests = (
  status: MediaRequestStatus,
  type: Notification
): Promise<MediaRequest[]> => {
  const requestRepository = getRepository(MediaRequest);

  // Join the requester's settings by hand: a query builder skips eager
  // relations, and without them emails ignored the requester's PGP key and
  // notification choices.
  return (
    requestRepository
      .createQueryBuilder('request')
      .leftJoinAndSelect('request.media', 'media')
      .leftJoinAndSelect('request.requestedBy', 'requestedBy')
      .leftJoinAndSelect('requestedBy.settings', 'requestedBySettings')
      .leftJoinAndSelect('request.seasons', 'seasons')
      .leftJoinAndSelect('request.albums', 'albums')
      .leftJoinAndSelect('request.songs', 'songs')
      .where('request.status = :status', { status })
      // Films, series and music: the types these notifications are worded for.
      .andWhere('request.type IN (:...types)', {
        types: [...VIDEO_MEDIA_TYPES, MediaType.MUSIC],
      })
      .andWhere(
        `NOT EXISTS (
        SELECT 1 FROM notification_delivery delivery
        WHERE delivery."requestId" = request.id
          AND delivery."type" = :type
          AND delivery."userId" = 0
          AND delivery."episodeKey" = ''
      )`,
        { type }
      )
      .getMany()
  );
};

class NotificationReconciler {
  private running = false;

  public async run(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      await this.pruneOrphanedDeliveries();
      await this.reconcileFailed();
      await this.reconcileAvailable();
      await this.reconcileCaughtUp();
      // About every half hour: what Maintainerr is about to delete.
      await tellLeavingSoon();
    } catch (e) {
      logger.error('Notification reconcile failed', {
        label: 'Notifications',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Clears delivery rows left by requests removed from Seerr (by a user, or a
   * tool like Maintainerr pruning media), keeping the table proportional to
   * live requests. Re-requesting is unaffected: a new request gets a new id
   * and so a new claim.
   */
  private async pruneOrphanedDeliveries(): Promise<void> {
    const deliveryRepository = getRepository(NotificationDelivery);

    const result = await deliveryRepository
      .createQueryBuilder()
      .delete()
      .where(
        `NOT EXISTS (
          SELECT 1 FROM media_request request
          WHERE request.id = "requestId"
        )`
      )
      .execute();

    if (result.affected) {
      logger.debug('Pruned orphaned notification delivery records', {
        label: 'Notifications',
        count: result.affected,
      });
    }
  }

  private async reconcileFailed(): Promise<void> {
    const requests = await findUnclaimedRequests(
      MediaRequestStatus.FAILED,
      Notification.MEDIA_FAILED
    );

    // A playlist's requests are announced together once settled.
    const listOf = await playlistOfRequests(
      requests
        .filter((request) => request.type === MediaType.MUSIC)
        .map((request) => request.id)
    );

    for (const request of requests) {
      // As in the other passes: a request whose title is gone has nothing to
      // announce, and trying failed on every pass.
      if (!request.media || listOf.has(request.id)) {
        continue;
      }

      await deliverSafely(request, request.media, Notification.MEDIA_FAILED);
    }

    await notifyPlaylistFailures(
      requests.filter((request) => request.media),
      listOf
    );
  }

  /**
   * An ongoing series may never become fully available: episodes keep airing,
   * so the request sits at partially available and the requester never hears
   * anything arrived.
   *
   * The useful moment is when everything aired at request time is downloaded:
   * they can watch up to where the show was. Later episodes are separate, and
   * the ordinary "now available" notification still fires if the series
   * completes.
   *
   * Only for a request that can't complete yet (a requested season with
   * episodes still to air). When every requested episode has aired, the
   * ordinary notification follows once the last season is available, and
   * announcing twice is noise.
   */
  private async reconcileCaughtUp(): Promise<void> {
    const requests = await getRepository(MediaRequest).find({
      where: {
        type: MediaType.TV,
        status: In([MediaRequestStatus.APPROVED, MediaRequestStatus.COMPLETED]),
      },
      relations: { media: true, requestedBy: true, seasons: true },
    });

    if (!requests.length) {
      return;
    }

    const mediaRepository = getRepository(Media);
    const tmdb = new TheMovieDb();
    const now = Date.now();

    for (const request of requests) {
      // Checked before any TMDB work: this runs every couple of minutes, and an
      // already-announced series must not cost a lookup per season.
      if (
        (await hasDelivery(
          request.id,
          Notification.MEDIA_AVAILABLE,
          0,
          CAUGHT_UP_CLAIM_KEY
        )) ||
        // Already announced as fully available.
        (await hasDelivery(request.id, Notification.MEDIA_AVAILABLE))
      ) {
        continue;
      }

      // A request can outlive its media row (library entry removed, request
      // kept). Nothing to reconcile, and reading through it would fail the
      // whole pass.
      if (!request.media) {
        continue;
      }

      // Episode availability is tracked only for the regular copy (episodeSync
      // reads the regular Sonarr), so it can't say a 4K request caught up; the
      // ordinary 4K notification still follows on completion.
      if (request.is4k) {
        continue;
      }

      const media = await mediaRepository.findOne({
        where: { id: request.media.id },
        relations: { seasons: true },
      });

      if (!media || media.status !== MediaStatus.PARTIALLY_AVAILABLE) {
        continue;
      }

      const requestedAt = request.createdAt?.getTime() ?? now;
      const requestedSeasons = new Set(
        (request.seasons ?? []).map((season) => season.seasonNumber)
      );
      let airedByRequest = 0;
      let missing = 0;
      let stillAiring = false;
      let lookupFailed = false;

      for (const season of media.seasons ?? []) {
        // Specials aren't part of the show's run, and unrequested seasons don't
        // decide whether the request is caught up.
        if (
          season.seasonNumber < 1 ||
          (requestedSeasons.size && !requestedSeasons.has(season.seasonNumber))
        ) {
          continue;
        }

        try {
          const details = await tmdb.getTvSeason({
            tvId: media.tmdbId,
            seasonNumber: season.seasonNumber,
          });

          const aired: number[] = [];
          for (const episode of details.episodes ?? []) {
            const airs = episode.air_date
              ? new Date(episode.air_date).getTime()
              : NaN;
            if (airs <= requestedAt) {
              aired.push(episode.episode_number);
            }
            // Undated counts as upcoming: TMDB lists announced episodes before
            // they have a date.
            if (Number.isNaN(airs) || airs > now) {
              stillAiring = true;
            }
          }

          // Each episode aired by then must be here: a count would let later
          // episodes make up for a missing earlier one.
          airedByRequest += aired.length;
          if (aired.length) {
            const here = await getRepository(Episode).count({
              where: {
                season: { id: season.id },
                status: MediaStatus.AVAILABLE,
                episodeNumber: In(aired),
              },
            });
            missing += aired.length - here;
          }
        } catch (e) {
          // Without air dates the comparison is meaningless, so say nothing
          // rather than announce something possibly untrue.
          lookupFailed = true;
          logger.debug('Could not read season air dates', {
            label: 'Notifications',
            tmdbId: media.tmdbId,
            seasonNumber: season.seasonNumber,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
          break;
        }
      }

      if (lookupFailed || !stillAiring || !airedByRequest || missing > 0) {
        continue;
      }

      await deliverSafely(
        request,
        media,
        Notification.MEDIA_AVAILABLE,
        CAUGHT_UP_CLAIM_KEY,
        seriesReadyToWatchEvent(),
        [
          {
            name: 'Episodes Available',
            value: `All ${airedByRequest} ${
              airedByRequest === 1 ? 'episode' : 'episodes'
            } aired so far`,
          },
        ]
      );
    }
  }

  private async reconcileAvailable(): Promise<void> {
    const requests = await findUnclaimedRequests(
      MediaRequestStatus.COMPLETED,
      Notification.MEDIA_AVAILABLE
    );

    if (!requests.length) {
      return;
    }

    const mediaRepository = getRepository(Media);

    for (const request of requests) {
      if (!request.media) {
        continue;
      }

      const media = await mediaRepository.findOne({
        where: { id: request.media.id },
        relations: { seasons: true },
      });

      if (!media || !(await isRequestAvailable(request, media))) {
        continue;
      }

      await deliverSafely(request, media, Notification.MEDIA_AVAILABLE);
    }
  }
}

const notificationReconciler = new NotificationReconciler();

export default notificationReconciler;
