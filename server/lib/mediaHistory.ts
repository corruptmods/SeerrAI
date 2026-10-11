import type { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MediaEvent, { MediaEventType } from '@server/entity/MediaEvent';
import logger from '@server/logger';
import type { EntityManager } from 'typeorm';

export { MediaEventType };

export interface MediaEventInput {
  tmdbId: number;
  mediaType: MediaType;
  type: MediaEventType;
  is4k?: boolean;
  userId?: number | null;
  detail?: string | null;
}

/**
 * Records one event in a title's history.
 *
 * Pass the EntityManager of the save it belongs to: inside a transaction, a
 * write through the global connection runs apart from it — on Postgres it
 * cannot see rows not yet committed, and would survive a rollback.
 *
 * Never throws. History is a record of what happened; failing to write it
 * must not undo or block the thing it records.
 */
export const recordMediaEvent = async (
  input: MediaEventInput,
  manager?: EntityManager
): Promise<void> => {
  try {
    await (manager ?? getRepository(MediaEvent).manager).insert(MediaEvent, {
      tmdbId: input.tmdbId,
      mediaType: input.mediaType,
      type: input.type,
      is4k: input.is4k ?? false,
      userId: input.userId ?? null,
      detail: input.detail ?? null,
    });
  } catch (e) {
    logger.warn('Could not record a history event', {
      label: 'Media History',
      tmdbId: input.tmdbId,
      mediaType: input.mediaType,
      type: input.type,
      errorMessage: e.message,
    });
  }
};
