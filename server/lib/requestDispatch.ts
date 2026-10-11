import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { MediaEventType, recordMediaEvent } from '@server/lib/mediaHistory';
import logger from '@server/logger';
import type { EntityManager } from 'typeorm';

/**
 * Records a request as failed when it cannot be dispatched at all.
 *
 * Without this the request stays APPROVED and the media sits at PROCESSING
 * forever: nothing was ever sent to Radarr or Sonarr, and `POST
 * /request/:id/retry` refuses anything that is not FAILED, so the only way out
 * was to delete the request and make it again (seerr-team/seerr#3460).
 *
 * Marking it failed makes it retryable and lets the existing failure
 * notification tell the requester something went wrong.
 */
export const markUndispatchable = async (
  entity: MediaRequest,
  reason: string,
  manager?: EntityManager
): Promise<void> => {
  logger.warn(reason, {
    label: 'Media Request',
    requestId: entity.id,
    mediaId: entity.media?.id,
  });

  try {
    if (entity.status !== MediaRequestStatus.FAILED) {
      /*
       * Written through the caller's transaction, and as an update rather
       * than a save.
       *
       * Callers run inside the subscriber that is still inserting this
       * request. Saving through the global repository used a different
       * Postgres connection, which could not see the uncommitted row — so
       * save() concluded it did not exist and inserted a second, FAILED
       * copy, leaving the original APPROVED. An update can never insert, and
       * does not cascade into the request's media and seasons.
       */
      await (manager ?? getRepository(MediaRequest).manager).update(
        MediaRequest,
        entity.id,
        { status: MediaRequestStatus.FAILED }
      );
      entity.status = MediaRequestStatus.FAILED;

      // An update does not reach the request hooks, so the failure and its
      // reason are recorded here.
      if (entity.media?.tmdbId) {
        await recordMediaEvent(
          {
            tmdbId: entity.media.tmdbId,
            mediaType: entity.media.mediaType,
            type: MediaEventType.FAILED,
            is4k: !!entity.is4k,
            detail: reason,
          },
          manager
        );
      }
    }
  } catch (e) {
    logger.error('Failed to mark undispatchable request as FAILED', {
      label: 'Media Request',
      requestId: entity.id,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
};

export default markUndispatchable;
