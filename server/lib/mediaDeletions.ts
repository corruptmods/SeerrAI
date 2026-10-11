import type { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MediaDeletion from '@server/entity/MediaDeletion';
import logger from '@server/logger';
import { In } from 'typeorm';

/**
 * Records that a title was removed from the library.
 *
 * Watchlist sync reads this to decide whether a watchlist entry predates the
 * deletion (leave it alone) or was added afterwards (the user wants it again).
 * Kept outside Media because deleting media can remove that row entirely.
 */
export const recordMediaDeletion = async (
  tmdbId: number,
  mediaType: MediaType
): Promise<void> => {
  try {
    const repository = getRepository(MediaDeletion);
    const existing = await repository.findOne({
      where: { tmdbId, mediaType },
    });

    if (existing) {
      // Latest deletion wins: re-adding and deleting again moves the line.
      existing.deletedAt = new Date();
      await repository.save(existing);

      return;
    }

    await repository.save(
      new MediaDeletion({ tmdbId, mediaType, deletedAt: new Date() })
    );
  } catch (e) {
    // Never fail a deletion because the bookkeeping failed — but say so: this
    // record is what stops a watchlist re-requesting a title that was
    // deliberately deleted, and a debug line is invisible by default.
    logger.warn('Could not record a media deletion', {
      label: 'Media',
      tmdbId,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
};

/** Deletion times for a set of titles, keyed as `mediaType:tmdbId`. */
export const getDeletionTimes = async (
  tmdbIds: number[]
): Promise<Map<string, Date>> => {
  if (!tmdbIds.length) {
    return new Map();
  }

  const rows = await getRepository(MediaDeletion).find({
    where: { tmdbId: In(tmdbIds) },
  });

  return new Map(
    rows.map((row) => [`${row.mediaType}:${row.tmdbId}`, row.deletedAt])
  );
};

export default recordMediaDeletion;
