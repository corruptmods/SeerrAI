import { IssueStatus, IssueTypeName } from '@server/constants/issue';
import { MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { getIntl } from '@server/i18n';
import globalMessages from '@server/i18n/globalMessages';
import { declineReasonOf } from '@server/lib/notifications/declineReason';
import { eventText } from '@server/lib/notifications/eventTitles';
import notificationHttp from '@server/lib/notifications/http';
import { mediaPagePath } from '@server/lib/notifications/mediaPage';
import type { NotificationAgentTelegram } from '@server/lib/settings';
import { NotificationAgentKey, getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { AvailableLocale } from '@server/types/languages';
import {
  Notification,
  hasNotificationType,
  shouldSendAdminNotification,
} from '..';
import type { NotificationAgent, NotificationPayload } from './agent';
import { BaseAgent } from './agent';

interface TelegramMessagePayload {
  text: string;
  parse_mode: string;
  chat_id: string;
  message_thread_id: string;
  disable_notification: boolean;
}

interface TelegramPhotoPayload {
  photo: string;
  caption: string;
  parse_mode: string;
  chat_id: string;
  message_thread_id: string;
  disable_notification: boolean;
}

/** The most characters Telegram takes in a photo's caption. */
const CAPTION_LIMIT = 1024;

class TelegramAgent
  extends BaseAgent<NotificationAgentTelegram>
  implements NotificationAgent
{
  private baseUrl = 'https://api.telegram.org/';

  protected getSettings(): NotificationAgentTelegram {
    if (this.settings) {
      return this.settings;
    }

    const settings = getSettings();

    return settings.notifications.agents.telegram;
  }

  public shouldSend(): boolean {
    const settings = this.getSettings();

    if (settings.enabled && settings.options.botAPI) {
      return true;
    }

    return false;
  }

  /**
   * Escapes text for Telegram's MarkdownV2, which refuses a whole message
   * over any of these characters left bare. The backslash is escaped in the
   * same single pass as the rest, so text is never escaped twice.
   */
  private escapeText(text: string | undefined): string {
    return text
      ? text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, (x) => '\\' + x)
      : '';
  }

  /** A link's address only needs its closing bracket and backslash escaped. */
  private escapeUrl(url: string): string {
    return url.replace(/[)\\]/g, (x) => '\\' + x);
  }

  private getNotificationPayload(
    type: Notification,
    payload: NotificationPayload,
    locale?: AvailableLocale
  ): Partial<TelegramMessagePayload | TelegramPhotoPayload> {
    const intl = getIntl(locale);
    const settings = getSettings();
    const { applicationUrl, applicationTitle } = settings.main;
    const { embedPoster } = settings.notifications.agents.telegram;

    const event = eventText(payload, intl);

    /* eslint-disable no-useless-escape */
    let message = `\*${this.escapeText(
      event ? `${event} - ${payload.subject}` : payload.subject
    )}\*`;
    if (payload.message) {
      message += `\n${this.escapeText(payload.message)}`;
    }

    if (payload.request) {
      message += `\n\n\*${this.escapeText(
        intl.formatMessage(globalMessages.requestedBy)
      )}:\* ${this.escapeText(payload.request?.requestedBy.displayName)}`;

      let status = '';
      switch (type) {
        case Notification.MEDIA_AUTO_REQUESTED:
          status =
            payload.media?.status === MediaStatus.PENDING
              ? intl.formatMessage(globalMessages.pendingApproval)
              : intl.formatMessage(globalMessages.processing);
          break;
        case Notification.MEDIA_PENDING:
          status = intl.formatMessage(globalMessages.pendingApproval);
          break;
        case Notification.MEDIA_APPROVED:
        case Notification.MEDIA_AUTO_APPROVED:
          status = intl.formatMessage(globalMessages.processing);
          break;
        case Notification.MEDIA_AVAILABLE:
          status = intl.formatMessage(globalMessages.available);
          break;
        case Notification.MEDIA_DECLINED:
          status = intl.formatMessage(globalMessages.declined);
          break;
        case Notification.MEDIA_FAILED:
          status = intl.formatMessage(globalMessages.failed);
          break;
      }

      if (status) {
        message += `\n\*${this.escapeText(
          intl.formatMessage(globalMessages.requestStatus)
        )}:\* ${this.escapeText(status)}`;
      }

      const declineReason = declineReasonOf(type, payload);
      if (declineReason) {
        message += `\n\*${this.escapeText(
          intl.formatMessage(globalMessages.declineReason)
        )}:\* ${this.escapeText(declineReason)}`;
      }
    } else if (payload.comment) {
      message += `\n\n\*${this.escapeText(
        intl.formatMessage(globalMessages.commentFrom, {
          userName: payload.comment.user.displayName,
        })
      )}:\* ${this.escapeText(payload.comment.message)}`;
    } else if (payload.issue) {
      message += `\n\n\*${this.escapeText(
        intl.formatMessage(globalMessages.reportedBy)
      )}:\* ${this.escapeText(payload.issue.createdBy.displayName)}`;
      message += `\n\*${this.escapeText(
        intl.formatMessage(globalMessages.issueType)
      )}:\* ${this.escapeText(IssueTypeName[payload.issue.issueType])}`;
      message += `\n\*${this.escapeText(
        intl.formatMessage(globalMessages.issueStatus)
      )}:\* ${this.escapeText(
        payload.issue.status === IssueStatus.OPEN
          ? intl.formatMessage(globalMessages.open)
          : intl.formatMessage(globalMessages.resolved)
      )}`;
    }

    for (const extra of payload.extra ?? []) {
      message += `\n\*${this.escapeText(extra.name)}:\* ${this.escapeText(
        extra.value
      )}`;
    }

    const url = applicationUrl
      ? payload.actionUrl
        ? `${applicationUrl}${payload.actionUrl}`
        : payload.issue
          ? `${applicationUrl}/issues/${payload.issue.id}`
          : payload.media
            ? `${applicationUrl}${mediaPagePath(payload.media, payload.request)}`
            : undefined
      : undefined;

    if (url) {
      message += `\n\n\[${this.escapeText(
        payload.actionUrl && payload.actionUrlTitle
          ? `${payload.actionUrlTitle} in ${applicationTitle}`
          : intl.formatMessage(
              payload.issue
                ? globalMessages.viewIssue
                : globalMessages.viewMedia,
              { applicationTitle }
            )
      )}\]\(${this.escapeUrl(url)}\)`;
    }
    /* eslint-enable */

    // Telegram refuses a caption over 1,024 characters, where a text message
    // may have 4,096. Escaped, the message is never shorter than Telegram
    // counts it, so one that might be too long for a caption goes as text.
    return embedPoster && payload.image && message.length <= CAPTION_LIMIT
      ? {
          photo: payload.image,
          caption: message,
          parse_mode: 'MarkdownV2',
        }
      : {
          text: message,
          parse_mode: 'MarkdownV2',
        };
  }

  public async send(
    type: Notification,
    payload: NotificationPayload
  ): Promise<boolean> {
    const settings = this.getSettings();
    // A poster goes with its caption, or the message is sent as text.
    const endpoint = (
      built: Partial<TelegramMessagePayload | TelegramPhotoPayload>
    ) =>
      `${this.baseUrl}bot${settings.options.botAPI}/${
        'photo' in built ? 'sendPhoto' : 'sendMessage'
      }`;

    // Send system notification
    if (
      payload.notifySystem &&
      hasNotificationType(type, settings.types ?? 0) &&
      settings.options.chatId
    ) {
      logger.debug('Sending Telegram notification', {
        label: 'Notifications',
        type: Notification[type],
        subject: payload.subject,
      });

      try {
        const notificationPayload = this.getNotificationPayload(type, payload);

        await notificationHttp.post(endpoint(notificationPayload), {
          ...notificationPayload,
          chat_id: settings.options.chatId,
          message_thread_id: settings.options.messageThreadId,
          disable_notification: !!settings.options.sendSilently,
        } as TelegramMessagePayload | TelegramPhotoPayload);
      } catch (e) {
        logger.error('Error sending Telegram notification', {
          label: 'Notifications',
          type: Notification[type],
          subject: payload.subject,
          errorMessage: e.message,
          response: e?.response?.data,
        });

        return false;
      }
    }

    // Held while a burst to this person is gathered into one (see the
    // notification manager): only the admin and channel copies go now.
    if (payload.notifyUser && !payload.holdUser) {
      if (
        payload.notifyUser.settings?.hasNotificationType(
          NotificationAgentKey.TELEGRAM,
          type
        ) &&
        payload.notifyUser.settings?.telegramChatId &&
        payload.notifyUser.settings.telegramChatId !== settings.options.chatId
      ) {
        logger.debug('Sending Telegram notification', {
          label: 'Notifications',
          recipient: payload.notifyUser.displayName,
          type: Notification[type],
          subject: payload.subject,
        });

        try {
          const notificationPayload = this.getNotificationPayload(
            type,
            payload,
            payload.notifyUser.settings?.locale as AvailableLocale
          );

          await notificationHttp.post(endpoint(notificationPayload), {
            ...notificationPayload,
            chat_id: payload.notifyUser.settings.telegramChatId,
            message_thread_id:
              payload.notifyUser.settings.telegramMessageThreadId,
            disable_notification:
              !!payload.notifyUser.settings.telegramSendSilently,
          } as TelegramMessagePayload | TelegramPhotoPayload);
        } catch (e) {
          logger.error('Error sending Telegram notification', {
            label: 'Notifications',
            recipient: payload.notifyUser.displayName,
            type: Notification[type],
            subject: payload.subject,
            errorMessage: e.message,
            response: e?.response?.data,
          });

          return false;
        }
      }
    }

    if (payload.notifyAdmin) {
      const userRepository = getRepository(User);
      const users = await userRepository.find();

      await Promise.all(
        users
          .filter(
            (user) =>
              user.settings?.hasNotificationType(
                NotificationAgentKey.TELEGRAM,
                type
              ) && shouldSendAdminNotification(type, user, payload)
          )
          .map(async (user) => {
            if (
              user.settings?.telegramChatId &&
              user.settings.telegramChatId !== settings.options.chatId
            ) {
              logger.debug('Sending Telegram notification', {
                label: 'Notifications',
                recipient: user.displayName,
                type: Notification[type],
                subject: payload.subject,
              });

              try {
                const notificationPayload = this.getNotificationPayload(
                  type,
                  payload,
                  user.settings?.locale as AvailableLocale
                );

                await notificationHttp.post(endpoint(notificationPayload), {
                  ...notificationPayload,
                  chat_id: user.settings.telegramChatId,
                  message_thread_id: user.settings.telegramMessageThreadId,
                  disable_notification: !!user.settings?.telegramSendSilently,
                } as TelegramMessagePayload | TelegramPhotoPayload);
              } catch (e) {
                logger.error('Error sending Telegram notification', {
                  label: 'Notifications',
                  recipient: user.displayName,
                  type: Notification[type],
                  subject: payload.subject,
                  errorMessage: e.message,
                  response: e?.response?.data,
                });

                return false;
              }
            }
          })
      );
    }

    return true;
  }
}

export default TelegramAgent;
