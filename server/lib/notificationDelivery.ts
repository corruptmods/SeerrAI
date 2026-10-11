import { getRepository } from '@server/datasource';
import { NotificationDelivery } from '@server/entity/NotificationDelivery';
import type { Notification } from '@server/lib/notifications';
import logger from '@server/logger';
import { isUniqueViolation } from '@server/utils/isUniqueViolation';

/**
 * Claims a notification for a request so it is only ever sent once.
 *
 * The unique constraint on (requestId, type) is the arbiter: whichever caller
 * inserts first wins, and every later attempt fails with a unique violation.
 * This is race-safe across the subscriber and the reconciler without a lock.
 *
 * Returns true when this call won the claim and the caller should send. Returns
 * false when the notification was already claimed, or when the claim could not
 * be recorded — never sending is preferred over sending twice.
 */
/**
 * Whether a notification has already been sent, without claiming it.
 *
 * Lets a caller skip expensive work — a TMDB lookup per season, say — for
 * something it has already told the user about.
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

/**
 * Releases a claim so the notification can be attempted again. Used when the
 * send itself fails after the claim was taken.
 */
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
