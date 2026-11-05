import { getRepository } from '@server/datasource';
import { MediaRequestWatcher } from '@server/entity/MediaRequestWatcher';
import { NotificationDelivery } from '@server/entity/NotificationDelivery';
import type { User } from '@server/entity/User';
import { Notification } from '@server/lib/notifications';
import logger from '@server/logger';
import { isUniqueViolation } from '@server/utils/isUniqueViolation';

/**
 * Whether a notification was already sent, without claiming it. Lets callers
 * skip expensive work (e.g. a TMDB lookup per season) for something already
 * announced.
 */
export const hasDelivery = async (
  requestId: number,
  type: Notification,
  userId = 0,
  episodeKey = ''
): Promise<boolean> =>
  (await getRepository(NotificationDelivery).countBy({
    requestId,
    type,
    userId,
    episodeKey,
  })) > 0;

/**
 * Claims a notification for a request so it is sent only once.
 *
 * The unique constraint on (requestId, type) arbitrates: the first insert
 * wins and later ones fail with a unique violation, race-safe across the
 * subscriber and the reconciler without a lock.
 *
 * Returns true when this call won and the caller should send; false when
 * already claimed or the claim couldn't be recorded (never sending beats
 * sending twice).
 */
export const claimDelivery = async (
  requestId: number,
  type: Notification,
  userId = 0,
  episodeKey = ''
): Promise<boolean> => {
  try {
    const repository = getRepository(NotificationDelivery);

    await repository.insert({
      requestId,
      type: type as number,
      userId,
      episodeKey,
    });

    return true;
  } catch (e) {
    if (isUniqueViolation(e)) {
      return false;
    }

    logger.error('Failed to record notification delivery', {
      label: 'Notifications',
      requestId,
      type,
      errorMessage: e instanceof Error ? e.message : String(e),
    });

    return false;
  }
};

/** Releases a claim so a failed send can be retried. */
export const releaseDelivery = async (
  requestId: number,
  type: Notification,
  userId = 0,
  episodeKey = ''
): Promise<void> => {
  try {
    const repository = getRepository(NotificationDelivery);
    await repository.delete({
      requestId,
      type: type as number,
      userId,
      episodeKey,
    });
  } catch (e) {
    logger.error('Failed to release notification delivery', {
      label: 'Notifications',
      requestId,
      type,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
};

/**
 * Tells each watcher of a request that it is ready to watch. The caller
 * notifies the requester, channels and admins separately; these are only the
 * watchers' copies. Each watcher has their own claim, so one failed send
 * can't block the others, and a failed one is released for a later retry.
 *
 * `send` sends one watcher's copy and returns whether it went out.
 */
export const notifyRequestWatchers = async (
  requestId: number,
  send: (watcher: User) => Promise<boolean> | boolean,
  episodeKey = ''
): Promise<void> => {
  const watchers = await getRepository(MediaRequestWatcher).find({
    where: { requestId },
    relations: { user: true },
  });

  for (const watcher of watchers) {
    if (
      !watcher.user ||
      !(await claimDelivery(
        requestId,
        Notification.MEDIA_AVAILABLE,
        watcher.userId,
        episodeKey
      ))
    ) {
      continue;
    }

    let sent = false;

    try {
      sent = await send(watcher.user);
    } catch (e) {
      logger.error('Failed to notify request watcher', {
        label: 'Notifications',
        requestId,
        userId: watcher.userId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }

    if (!sent) {
      await releaseDelivery(
        requestId,
        Notification.MEDIA_AVAILABLE,
        watcher.userId,
        episodeKey
      );
    }
  }
};
