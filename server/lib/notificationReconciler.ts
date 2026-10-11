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
import { MediaRequestWatcher } from '@server/entity/MediaRequestWatcher';
import { NotificationDelivery } from '@server/entity/NotificationDelivery';
import {
  claimDelivery,
  hasDelivery,
  releaseDelivery,
} from '@server/lib/notificationDelivery';
import { Notification } from '@server/lib/notifications';
import logger from '@server/logger';
import { In } from 'typeorm';

const isRequestAvailable = (request: MediaRequest, media: Media): boolean => {
  const statusKey = request.is4k ? 'status4k' : 'status';

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
 * The subscriber fans availability out to watchers itself; when the
 * reconciler is the path that caught a missed notification, it has to do the
 * same or watchers silently miss out.
 */
const notifyWatchersForRequest = async (
  request: MediaRequest,
  media: Media,
  episodeKey = ''
): Promise<void> => {
  const watchers: MediaRequestWatcher[] = await getRepository(
    MediaRequestWatcher
  ).find({ where: { requestId: request.id }, relations: { user: true } });

  for (const watcher of watchers) {
    if (
      !watcher.user ||
      !(await claimDelivery(
        request.id,
        Notification.MEDIA_AVAILABLE,
        watcher.userId,
        episodeKey
      ))
    ) {
      continue;
    }

    const sent = await MediaRequest.sendNotification(
      { ...request, requestedBy: watcher.user } as MediaRequest,
      media,
      Notification.MEDIA_AVAILABLE
    );

    if (!sent) {
      await releaseDelivery(
        request.id,
        Notification.MEDIA_AVAILABLE,
        watcher.userId,
        episodeKey
      );
    }
  }
};

/**
 * One claim per request, so the catch-up moment is announced exactly once
 * however many episodes air afterwards.
 */
/**
 * One request failing must not abandon the rest of the pass. A single bad row
 * used to abort the whole reconcile, so everything after it was never
 * notified.
 */
const deliverSafely = async (
  request: MediaRequest,
  media: Media,
  type: Notification,
  episodeKey = '',
  eventOverride?: string,
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

const CAUGHT_UP_CLAIM_KEY = 'caught-up';

const deliver = async (
  request: MediaRequest,
  media: Media,
  type: Notification,
  episodeKey = '',
  eventOverride?: string,
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

  if (sent && type === Notification.MEDIA_AVAILABLE) {
    await notifyWatchersForRequest(request, media, episodeKey);
  }

  if (!sent) {
    // sendNotification has already logged the failure. Release the claim so
    // the next reconcile pass can try again: the very claim taken above,
    // with its episode key, or the pass would find it still held.
    await releaseDelivery(request.id, type, 0, episodeKey);

    logger.warn('Released notification claim after failed send', {
      label: 'Notifications',
      requestId: request.id,
      type: Notification[type],
    });
  }
};

/**
 * Loads requests in the given status that have no delivery row for the given
 * notification type. Filtering in the query keeps each pass proportional to
 * the number of outstanding notifications rather than the size of the request
 * history.
 */
const findUnclaimedRequests = (
  status: MediaRequestStatus,
  type: Notification
): Promise<MediaRequest[]> => {
  const requestRepository = getRepository(MediaRequest);

  return requestRepository
    .createQueryBuilder('request')
    .leftJoinAndSelect('request.media', 'media')
    .leftJoinAndSelect('request.requestedBy', 'requestedBy')
    .leftJoinAndSelect('request.seasons', 'seasons')
    .where('request.status = :status', { status })
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
    .getMany();
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
   * Requests removed from Seerr — by a user, or by an external tool such as
   * Maintainerr pruning media — leave their delivery rows behind. Clearing
   * them keeps the table proportional to live requests. Re-requesting is
   * unaffected either way, since a new request gets a new id and therefore a
   * new claim.
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

    for (const request of requests) {
      // As in the other passes: a request whose title is gone has nothing to
      // announce, and trying failed on every pass.
      if (!request.media) {
        continue;
      }

      await deliverSafely(request, request.media, Notification.MEDIA_FAILED);
    }
  }

  /**
   * An ongoing series may never reach fully available: episodes keep airing,
   * so the request sits at partially available and the requester is never told
   * anything arrived.
   *
   * The useful moment is when everything that had already aired when they
   * asked for it is downloaded — at that point they can watch the show up to
   * where it had got to. Episodes that aired afterwards are a different
   * matter, and the ordinary "now available" notification still fires if the
   * series ever completes.
   *
   * Only for a request that cannot complete yet — a requested season with
   * episodes still to air. When every requested episode has aired, the
   * ordinary notification follows as soon as the last season is marked
   * available, and announcing the same thing twice is noise.
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
      // Checked before any TMDB work: this runs every couple of minutes, and
      // a series already announced must not cost a lookup per season.
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

      // A request can outlive the media row it pointed at — the library entry
      // is removed while the request stays. Nothing to reconcile, and reading
      // through it would fail the whole pass.
      if (!request.media) {
        continue;
      }

      // Episode availability is only kept for the regular copy (episodeSync
      // reads the regular Sonarr), so it cannot say a 4K request has caught
      // up; the ordinary 4K notification still follows when it completes.
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
        // Specials are not part of the run of the show, and seasons nobody
        // asked for do not decide whether the request is caught up.
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
            // Undated counts as still to come: TMDB lists announced episodes
            // before they have a date.
            if (Number.isNaN(airs) || airs > now) {
              stillAiring = true;
            }
          }

          // Each episode aired by then must itself be here: a count would
          // let later episodes make up for an earlier one still missing.
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
          // Without the air dates the comparison is meaningless, so say
          // nothing rather than announce something that may not be true.
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
        'Series Ready to Watch',
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

      if (!media || !isRequestAvailable(request, media)) {
        continue;
      }

      await deliverSafely(request, media, Notification.MEDIA_AVAILABLE);
    }
  }
}

const notificationReconciler = new NotificationReconciler();

export default notificationReconciler;
