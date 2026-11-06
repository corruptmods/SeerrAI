import { MediaRequestStatus } from '@server/constants/media';
import discordBot from '@server/lib/notifications/discordBot';
import type { NotificationAgentDiscordBot } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Notification } from '..';
import type { NotificationAgent, NotificationPayload } from './agent';
import { BaseAgent } from './agent';

/** What a request waiting for approval can become, as notified. */
const SETTLED = new Set([
  Notification.MEDIA_APPROVED,
  Notification.MEDIA_DECLINED,
  // Sent instead of approved when the title is already there.
  Notification.MEDIA_AVAILABLE,
]);

/**
 * The Discord bot's side of notifications: it posts requests waiting for
 * approval, with Approve and Decline, and takes the buttons off once they're
 * approved or declined elsewhere. Nothing else; the webhook agent
 * (agents/discord) carries everything else to Discord.
 */
class DiscordBotAgent
  extends BaseAgent<NotificationAgentDiscordBot>
  implements NotificationAgent
{
  protected getSettings(): NotificationAgentDiscordBot {
    return this.settings ?? getSettings().notifications.agents.discordBot;
  }

  public shouldSend(): boolean {
    const { enabled, options } = this.getSettings();
    return !!(enabled && options.botToken && options.channelId);
  }

  public async send(
    type: Notification,
    payload: NotificationPayload
  ): Promise<boolean> {
    const request = payload.request;
    if (!request?.id) {
      return true;
    }

    if (
      type === Notification.MEDIA_PENDING &&
      payload.notifySystem &&
      !payload.digest
    ) {
      try {
        await discordBot.postPending(payload);
        return true;
      } catch (e) {
        logger.error('Error posting a request to Discord with the bot', {
          label: 'Notifications',
          requestId: request.id,
          subject: payload.subject,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
        return false;
      }
    }

    if (SETTLED.has(type) && request.status !== MediaRequestStatus.PENDING) {
      await discordBot.settle(request).catch((e) =>
        logger.debug('Could not update the Discord bot’s message', {
          label: 'Notifications',
          requestId: request.id,
          errorMessage: e instanceof Error ? e.message : String(e),
        })
      );
    }

    return true;
  }
}

export default DiscordBotAgent;
