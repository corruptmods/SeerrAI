import { Notification } from '.';
import type { NotificationPayload } from './agents/agent';

/** The decline reason for a MEDIA_DECLINED notification, if one was given. */
export const declineReasonOf = (
  type: Notification,
  payload: NotificationPayload
): string | undefined => {
  if (type !== Notification.MEDIA_DECLINED) {
    return undefined;
  }
  return payload.request?.declineReason?.trim() || undefined;
};

/**
 * Backslash-escapes all ASCII punctuation, so CommonMark (Gotify, ntfy) and
 * Discord show it literally: no formatting, links or mentions.
 */
export const escapeMarkdown = (text: string): string =>
  text.replace(/[!-/:-@[-`{-~]/g, '\\$&');

/**
 * Escapes text for Slack's mrkdwn, so it can't link or mention ("<url|text>",
 * "<!channel>").
 */
export const escapeSlack = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Escapes text for HTML. */
export const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (ch) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[ch] as string
  );
