import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { MediaEventType, recordMediaEvent } from '@server/lib/mediaHistory';
import logger from '@server/logger';
import type { EntityManager } from 'typeorm';

/**
 * Marks a request failed when it can't be dispatched at all.
 *
 * Otherwise it stays APPROVED and the media sits at PROCESSING forever: nothing
 * reached Radarr or Sonarr, and `POST /request/:id/retry` only accepts FAILED,
 * so the only way out was deleting and re-requesting (seerr-team/seerr#3460).
 * FAILED makes it retryable and lets the failure notification tell the
 * requester.
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
       * Written via the caller's transaction, as an update, not a save.
       *
       * Callers run inside the subscriber still inserting this request. Saving
       * through the global repository used another Postgres connection that
       * couldn't see the uncommitted row, so save() inserted a second, FAILED
       * copy and left the original APPROVED. An update never inserts and
       * doesn't cascade into the request's media and seasons.
       */
      await (manager ?? getRepository(MediaRequest).manager).update(
        MediaRequest,
        entity.id,
        { status: MediaRequestStatus.FAILED }
      );
      entity.status = MediaRequestStatus.FAILED;

      // Updates bypass the request hooks, so record the failure and reason
      // here.
      if (entity.media?.tmdbId || entity.media?.foreignId) {
        await recordMediaEvent(
          {
            tmdbId: entity.media.tmdbId,
            foreignId: entity.media.foreignId,
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
