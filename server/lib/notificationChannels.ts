import { getRepository } from '@server/datasource';
import type { User } from '@server/entity/User';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { getSettings, NotificationAgentKey } from '@server/lib/settings';

/**
 * Whether a user has any working notification channel. Opting in without one
 * is a silent no-op, so the UI checks this first.
 */
export const getNotificationChannels = async (
  user: User
): Promise<{ reachable: boolean; channels: string[] }> => {
  const settings = getSettings().notifications.agents;
  const channels: string[] = [];

  // Web push: a live subscription on at least one device.
  if (settings.webpush?.enabled) {
    const deviceCount = await getRepository(UserPushSubscription).count({
      where: { user: { id: user.id } },
    });

    if (deviceCount > 0) {
      channels.push(NotificationAgentKey.WEBPUSH);
    }
  }

  if (settings.email?.enabled && user.email) {
    channels.push(NotificationAgentKey.EMAIL);
  }

  if (settings.discord?.enabled && user.settings?.discordIds?.length) {
    channels.push(NotificationAgentKey.DISCORD);
  }

  if (settings.telegram?.enabled && user.settings?.telegramChatId) {
    channels.push(NotificationAgentKey.TELEGRAM);
  }

  return { reachable: channels.length > 0, channels };
};

export default getNotificationChannels;
