import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import notificationManager, { Notification } from '@server/lib/notifications';
import logger from '@server/logger';
import { IsNull } from 'typeorm';

/**
 * Records that Plex rejected this user's token, and tells them once.
 *
 * A rejected token silently stops their watchlist sync, and they have no
 * reason to open Seerr to notice. The flag is set with a conditional update,
 * so only the run that flips it notifies; later syncs while the token stays
 * broken are no-ops.
 */
export const markPlexTokenRejected = async (user: User): Promise<void> => {
  const result = await getRepository(User)
    .createQueryBuilder()
    .update(User)
    .set({ plexTokenExpiredAt: new Date() })
    .where({ id: user.id, plexTokenExpiredAt: IsNull() })
    .execute();

  if (!result.affected) {
    return;
  }

  logger.warn('Plex rejected this user’s token; notifying them to sign in', {
    label: 'Plex Sign-in',
    userId: user.id,
  });

  notificationManager.sendNotification(Notification.PLEX_REAUTH, {
    notifyAdmin: false,
    notifySystem: false,
    notifyUser: user,
    subject: 'Plex sign-in expired',
    message:
      'Your Plex watchlist has stopped syncing. Sign out of Seerr and sign back in with Plex to reconnect it.',
  });
};

/**
 * Clears the flag once Plex accepts the token again (after sign-in, or a
 * transient rejection). Writes only when the flag is set, so a healthy sync
 * costs no write.
 */
export const clearPlexTokenRejected = async (user: User): Promise<void> => {
  if (!user.plexTokenExpiredAt) {
    return;
  }

  await getRepository(User).update(user.id, { plexTokenExpiredAt: null });
  user.plexTokenExpiredAt = null;
};
