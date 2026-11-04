import TheMovieDb from '@server/api/themoviedb';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import type { DeletingSoonItem } from '@server/lib/deletingSoon';
import {
  getDeletingSoon,
  isMaintainerrConfigured,
} from '@server/lib/deletingSoon';
import { featureEnabled } from '@server/lib/features';
import { claimDelivery } from '@server/lib/notificationDelivery';
import notificationManager, { Notification } from '@server/lib/notifications';
import logger from '@server/logger';
import { In } from 'typeorm';

/*
 * Leaving Soon: whoever requested a film or series is told when Maintainerr
 * is about to delete it, once for each date it is set to go. Kept, and set
 * to go again later, it is told again then.
 */

const DAY_MS = 24 * 60 * 60_000;
/** How often the deletion schedule is looked through. */
const EVERY_MS = 30 * 60_000;

let lastRun = 0;

const titleOf = async (
  tmdb: TheMovieDb,
  item: DeletingSoonItem
): Promise<{ title: string; image?: string }> => {
  const poster = (path?: string | null) =>
    path ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${path}` : undefined;
  if (item.mediaType === MediaType.MOVIE) {
    const movie = await tmdb.getMovie({ movieId: item.tmdbId });
    return { title: movie.title, image: poster(movie.poster_path) };
  }
  const show = await tmdb.getTvShow({ tvId: item.tmdbId });
  return { title: show.name, image: poster(show.poster_path) };
};

/** "in 3 days", "tomorrow", "today". */
const when = (deleteAt: Date, now: number): string => {
  const days = Math.ceil((deleteAt.getTime() - now) / DAY_MS);
  return days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
};

/** Tells requesters what Maintainerr is about to delete. */
export const tellLeavingSoon = async (now = Date.now()): Promise<void> => {
  if (now - lastRun < EVERY_MS || !isMaintainerrConfigured()) return;
  lastRun = now;
  const items = await getDeletingSoon();
  if (!items.length) return;
  const tmdb = new TheMovieDb();

  for (const item of items) {
    try {
      const media = await getRepository(Media).findOne({
        select: { id: true },
        where: { tmdbId: item.tmdbId, mediaType: item.mediaType },
      });
      if (!media) continue;
      const requests = await getRepository(MediaRequest).find({
        where: {
          media: { id: media.id },
          status: In([
            MediaRequestStatus.APPROVED,
            MediaRequestStatus.COMPLETED,
          ]),
        },
        order: { id: 'ASC' },
      });
      // Each requester once, by their first request for it.
      const asked = new Map<number, { user: User; requestId: number }>();
      for (const request of requests) {
        const user = request.requestedBy;
        if (!user || request.requesterMuted || asked.has(user.id)) continue;
        if (!featureEnabled('deletingSoon', user)) continue;
        asked.set(user.id, { user, requestId: request.id });
      }
      if (!asked.size) continue;

      const day = item.deleteAt.toISOString().slice(0, 10);
      let about: { title: string; image?: string } | undefined;
      for (const { user, requestId } of asked.values()) {
        if (
          !(await claimDelivery(
            requestId,
            Notification.LEAVING_SOON,
            user.id,
            day
          ))
        ) {
          continue;
        }
        about ??= await titleOf(tmdb, item);
        notificationManager.sendNotification(Notification.LEAVING_SOON, {
          subject: `${about.title} is leaving soon`,
          message: `It’s set to be removed ${when(item.deleteAt, now)}.${
            item.canKeep ? ' Open it and choose Keep to hold on to it.' : ''
          }`,
          image: about.image,
          notifyAdmin: false,
          notifySystem: false,
          notifyUser: user,
          actionUrl: `/${item.mediaType === MediaType.MOVIE ? 'movie' : 'tv'}/${item.tmdbId}`,
          actionUrlTitle: 'View',
        });
      }
    } catch (e) {
      logger.warn('Could not tell what is leaving soon', {
        label: 'Notifications',
        tmdbId: item.tmdbId,
        mediaType: item.mediaType,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }
};

/** Forgets when it last ran (for tests). */
export const resetLeavingSoon = (): void => {
  lastRun = 0;
};
