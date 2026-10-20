import { IssueStatus, IssueType } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import { declineReasonOf } from '@server/lib/notifications/declineReason';
import notificationHttp from '@server/lib/notifications/http';
import type { NotificationAgentWebhook } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { get } from 'lodash';
import { Notification, hasNotificationType } from '..';
import type { NotificationAgent, NotificationPayload } from './agent';
import { BaseAgent } from './agent';

type KeyMapFunction = (
  payload: NotificationPayload,
  type: Notification
) => string;

/**
 * The variables a webhook's payload can use. The Jellyfin ones keep their
 * meaning on a server set up with Emby, whose ids they carried before Emby
 * had its own; the Emby ones are Emby's alone.
 */
export const KeyMap: Record<string, string | KeyMapFunction> = {
  notification_type: (_payload, type) => Notification[type],
  event: 'event',
  subject: 'subject',
  message: 'message',
  image: 'image',
  notifyuser_username: 'notifyUser.displayName',
  notifyuser_email: 'notifyUser.email',
  notifyuser_avatar: 'notifyUser.avatar',
  notifyuser_settings_discordIds: 'notifyUser.settings.discordIds',
  notifyuser_settings_telegramChatId: 'notifyUser.settings.telegramChatId',
  media_imdbid: 'media.imdbId',
  media_tmdbid: 'media.tmdbId',
  media_tvdbid: 'media.tvdbId',
  media_type: 'media.mediaType',
  /** For music (whose TMDB id is 0): the artist's MusicBrainz id. */
  media_mbid: (payload) =>
    payload.media?.mediaType === MediaType.MUSIC
      ? (payload.media.foreignId ?? '')
      : '',
  /** For music: the titles of the albums asked for, one per line. */
  music_albums: (payload) =>
    payload.media?.mediaType === MediaType.MUSIC
      ? (payload.request?.albums ?? []).map((album) => album.title).join('\n')
      : '',
  media_jellyfinMediaId: (payload) =>
    payload.media?.jellyfinMediaId ??
    payload.media?.jellyfinMediaId4k ??
    payload.media?.embyMediaId ??
    payload.media?.embyMediaId4k ??
    '',
  media_embyMediaId: (payload) =>
    payload.media?.embyMediaId ?? payload.media?.embyMediaId4k ?? '',
  media_status: (payload) =>
    payload.media ? MediaStatus[payload.media.status] : '',
  media_status4k: (payload) =>
    payload.media ? MediaStatus[payload.media.status4k] : '',
  media_plexRatingKey: (payload) => payload.media?.ratingKey ?? '',
  media_plexRatingKey4k: (payload) => payload.media?.ratingKey4k ?? '',
  request_id: 'request.id',
  requestedBy_jellyfinUserId: (payload) =>
    payload.request?.requestedBy?.jellyfinUserId ??
    payload.request?.requestedBy?.embyUserId ??
    '',
  requestedBy_embyUserId: (payload) =>
    payload.request?.requestedBy?.embyUserId ?? '',
  requestedBy_username: 'request.requestedBy.displayName',
  requestedBy_email: 'request.requestedBy.email',
  requestedBy_avatar: 'request.requestedBy.avatar',
  requestedBy_settings_discordIds: 'request.requestedBy.settings.discordIds',
  requestedBy_settings_telegramChatId:
    'request.requestedBy.settings.telegramChatId',
  decline_reason: (payload, type) => declineReasonOf(type, payload) ?? '',
  issue_id: 'issue.id',
  issue_type: (payload) =>
    payload.issue ? IssueType[payload.issue.issueType] : '',
  issue_status: (payload) =>
    payload.issue ? IssueStatus[payload.issue.status] : '',
  reportedBy_username: 'issue.createdBy.displayName',
  reportedBy_email: 'issue.createdBy.email',
  reportedBy_avatar: 'issue.createdBy.avatar',
  reportedBy_settings_discordIds: 'issue.createdBy.settings.discordIds',
  reportedBy_settings_telegramChatId: 'issue.createdBy.settings.telegramChatId',
  comment_message: 'comment.message',
  commentedBy_username: 'comment.user.displayName',
  commentedBy_email: 'comment.user.email',
  commentedBy_avatar: 'comment.user.avatar',
  commentedBy_settings_discordIds: 'comment.user.settings.discordIds',
  commentedBy_settings_telegramChatId: 'comment.user.settings.telegramChatId',
};

/** A variable in a webhook's address or payload, such as {{subject}}. */
const VARIABLE = /\{\{(\w+)\}\}/g;

/** A variable's value for this notification, as text; '' when it has none. */
const variableValue = (
  key: string,
  payload: NotificationPayload,
  type: Notification
): string => {
  const keymapValue = KeyMap[key];
  const value =
    typeof keymapValue === 'function'
      ? keymapValue(payload, type)
      : get(payload, keymapValue);
  return value == null ? '' : String(value);
};

/**
 * Fills a template's variables in one pass over the template as written:
 * every copy of each is filled, and a value goes in exactly as it is, so a
 * "$" in it or a "{{…}}" someone typed into an issue is never read as part
 * of the template. Anything in braces that is not a variable is left be.
 */
const fillVariables = (
  template: string,
  valueOf: (key: string) => string
): string =>
  template.replace(VARIABLE, (variable, key: string) =>
    Object.hasOwn(KeyMap, key) ? valueOf(key) : variable
  );

class WebhookAgent
  extends BaseAgent<NotificationAgentWebhook>
  implements NotificationAgent
{
  protected getSettings(): NotificationAgentWebhook {
    if (this.settings) {
      return this.settings;
    }

    const settings = getSettings();

    return settings.notifications.agents.webhook;
  }

  private parseKeys(
    finalPayload: Record<string, unknown>,
    payload: NotificationPayload,
    type: Notification
  ): Record<string, unknown> {
    Object.keys(finalPayload).forEach((key) => {
      if (key === '{{extra}}') {
        finalPayload.extra = payload.extra ?? [];
        delete finalPayload[key];
        key = 'extra';
      } else if (key === '{{media}}') {
        if (payload.media) {
          finalPayload.media = finalPayload[key];
        } else {
          finalPayload.media = null;
        }
        delete finalPayload[key];
        key = 'media';
      } else if (key === '{{request}}') {
        if (payload.request) {
          finalPayload.request = finalPayload[key];
        } else {
          finalPayload.request = null;
        }
        delete finalPayload[key];
        key = 'request';
      } else if (key === '{{issue}}') {
        if (payload.issue) {
          finalPayload.issue = finalPayload[key];
        } else {
          finalPayload.issue = null;
        }
        delete finalPayload[key];
        key = 'issue';
      } else if (key === '{{comment}}') {
        if (payload.comment) {
          finalPayload.comment = finalPayload[key];
        } else {
          finalPayload.comment = null;
        }
        delete finalPayload[key];
        key = 'comment';
      }

      if (typeof finalPayload[key] === 'string') {
        finalPayload[key] = fillVariables(finalPayload[key] as string, (k) =>
          variableValue(k, payload, type)
        );
      } else if (finalPayload[key] && typeof finalPayload[key] === 'object') {
        finalPayload[key] = this.parseKeys(
          finalPayload[key] as Record<string, unknown>,
          payload,
          type
        );
      }
    });

    return finalPayload;
  }

  private buildPayload(type: Notification, payload: NotificationPayload) {
    const payloadString = Buffer.from(
      this.getSettings().options.jsonPayload,
      'base64'
    ).toString('utf8');

    const parsedJSON = JSON.parse(JSON.parse(payloadString));

    return this.parseKeys(parsedJSON, payload, type);
  }

  public shouldSend(): boolean {
    const settings = this.getSettings();

    if (settings.enabled && settings.options.webhookUrl) {
      return true;
    }

    return false;
  }

  public async send(
    type: Notification,
    payload: NotificationPayload
  ): Promise<boolean> {
    const settings = this.getSettings();

    if (
      !payload.notifySystem ||
      !hasNotificationType(type, settings.types ?? 0)
    ) {
      return true;
    }

    logger.debug('Sending webhook notification', {
      label: 'Notifications',
      type: Notification[type],
      subject: payload.subject,
    });

    let webhookUrl = settings.options.webhookUrl;

    // The test notification has no title or request behind it, so its
    // address is filled with "test"; a real one gets each value, or nothing
    // (a music title's TMDB id stays 0).
    if (settings.options.supportVariables) {
      webhookUrl = fillVariables(webhookUrl, (key) =>
        encodeURIComponent(
          type === Notification.TEST_NOTIFICATION
            ? 'test'
            : variableValue(key, payload, type)
        )
      );
    }

    try {
      const headers: Record<string, string> = {};

      if (settings.options.authHeader) {
        headers.Authorization = settings.options.authHeader;
      }

      if (
        settings.options.customHeaders &&
        settings.options.customHeaders.length > 0
      ) {
        settings.options.customHeaders.forEach((header) => {
          const key = header.key?.trim();
          const value = header.value?.trim();

          if (key && value) {
            // Don't override Authorization header if it's already set via authHeader
            if (
              key.toLowerCase() !== 'authorization' ||
              !settings.options.authHeader
            ) {
              headers[key] = value;
            }
          }
        });
      }

      await notificationHttp.post(
        webhookUrl,
        this.buildPayload(type, payload),
        Object.keys(headers).length > 0 ? { headers } : undefined
      );

      return true;
    } catch (e) {
      logger.error('Error sending webhook notification', {
        label: 'Notifications',
        type: Notification[type],
        subject: payload.subject,
        errorMessage: e.message,
        response: e?.response?.data,
      });

      return false;
    }
  }
}

export default WebhookAgent;
