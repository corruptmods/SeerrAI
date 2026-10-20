import type { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MediaEvent, { MediaEventType } from '@server/entity/MediaEvent';
import { User } from '@server/entity/User';
import logger from '@server/logger';
import { withNestedTransaction } from '@server/utils/nestedTransaction';
import type { EntityManager, FindOptionsWhere } from 'typeorm';
import { In } from 'typeorm';

export { MediaEventType };

export interface MediaEventInput {
  /** 0 for music, which is kept by `foreignId` instead. */
  tmdbId: number;
  /** For music: the artist's MusicBrainz id. */
  foreignId?: string | null;
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
  const insert = (into: EntityManager) =>
    into.insert(MediaEvent, {
      tmdbId: input.tmdbId,
      foreignId: input.foreignId ?? null,
      mediaType: input.mediaType,
      type: input.type,
      is4k: input.is4k ?? false,
      userId: input.userId ?? null,
      detail: input.detail ?? null,
    });

  try {
    // Inside a transaction, in a nested one of its own: on Postgres a write
    // that fails aborts the transaction it is in, which would lose the save
    // being recorded and everything after it.
    await (manager?.queryRunner?.isTransactionActive
      ? withNestedTransaction(manager, insert)
      : insert(manager ?? getRepository(MediaEvent).manager));
  } catch (e) {
    logger.warn('Could not record a history event', {
      label: 'Media History',
      tmdbId: input.tmdbId,
      foreignId: input.foreignId ?? undefined,
      mediaType: input.mediaType,
      type: input.type,
      errorMessage: e.message,
    });
  }
};

/** One event as the manage panel shows it. */
export interface MediaHistoryEntry {
  id: number;
  type: MediaEventType;
  is4k: boolean;
  detail: string | null;
  occurredAt: Date;
  user: { id: number; displayName: string; avatar: string } | null;
}

/**
 * A title's history, newest first, with who did each thing: by TMDB id for
 * films and series, by `foreignId` for music.
 */
export const mediaHistory = async (
  where: FindOptionsWhere<MediaEvent>
): Promise<MediaHistoryEntry[]> => {
  const events = await getRepository(MediaEvent).find({
    where,
    order: { occurredAt: 'DESC', id: 'DESC' },
    take: 100,
  });

  const userIds = [
    ...new Set(events.map((e) => e.userId).filter((id) => id != null)),
  ] as number[];
  const users = userIds.length
    ? await getRepository(User).find({ where: { id: In(userIds) } })
    : [];
  const byId = new Map(users.map((user) => [user.id, user]));

  return events.map((event) => {
    const user = event.userId != null ? byId.get(event.userId) : null;
    return {
      id: event.id,
      type: event.type,
      is4k: event.is4k,
      detail: event.detail ?? null,
      occurredAt: event.occurredAt,
      user: user
        ? {
            id: user.id,
            displayName: user.displayName,
            avatar: user.avatar,
          }
        : null,
    };
  });
};
