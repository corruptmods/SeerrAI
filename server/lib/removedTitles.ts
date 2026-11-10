import type { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MediaDeletion from '@server/entity/MediaDeletion';
import MediaEvent, { MediaEventType } from '@server/entity/MediaEvent';
import { getSettings } from '@server/lib/settings';
import { In } from 'typeorm';

/*
 * Settings → Users → Requests for Removed Titles: a title removed from the
 * library before (deleted from the media server, by Maintainerr say, or its
 * files removed from Seerr AI) can wait for an admin when requested again, or
 * be refused. Off by default; admins and request managers aren't affected.
 */

export type RemovedTitleRequests = 'off' | 'approve' | 'refuse';

/** How often a title has left the library, as its history and deletion record say. */
export const timesRemoved = async (
  tmdbId: number,
  mediaType: MediaType
): Promise<number> => {
  const [events, deletion] = await Promise.all([
    getRepository(MediaEvent).count({
      where: {
        tmdbId,
        mediaType,
        type: In([MediaEventType.REMOVED, MediaEventType.FILES_REMOVED]),
      },
    }),
    getRepository(MediaDeletion).exists({ where: { tmdbId, mediaType } }),
  ]);
  // Older deletions may predate the history; the record still counts once.
  return Math.max(events, deletion ? 1 : 0);
};

/**
 * What the setting asks of a new request for this title: nothing, an admin's
 * approval, or a refusal. Also how often it was removed, when that matters.
 */
export const removedTitleRule = async (
  tmdbId: number,
  mediaType: MediaType
): Promise<{ rule: RemovedTitleRequests; times: number }> => {
  const { removedTitleRequests = 'off', removedTitleTimes = 1 } =
    getSettings().main;
  if (removedTitleRequests === 'off') {
    return { rule: 'off', times: 0 };
  }
  const times = await timesRemoved(tmdbId, mediaType);
  return times >= Math.max(1, removedTitleTimes)
    ? { rule: removedTitleRequests, times }
    : { rule: 'off', times };
};
