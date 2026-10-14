import { Notification } from '.';
import type { NotificationPayload } from './agents/agent';

/**
 * Why a request was declined, for the notification saying so: only on a
 * "declined" notification, and only when whoever declined it gave a reason.
 */
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
 * Text to be shown as written in markdown: every ASCII punctuation mark is
 * escaped with a backslash, which CommonMark (Gotify, ntfy) and Discord both
 * show as the mark itself. Nothing in it can become formatting, a link or a
 * mention.
 */
export const escapeMarkdown = (text: string): string =>
  text.replace(/[!-/:-@[-`{-~]/g, '\\$&');

/** Text to be shown as written in HTML. */
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
