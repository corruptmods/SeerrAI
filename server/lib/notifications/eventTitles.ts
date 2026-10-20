import { createIntl, createIntlCache } from '@formatjs/intl';
import { IssueType } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import type { getIntl } from '@server/i18n';
import { defineMessages } from '@server/i18n';
import { Notification } from '.';

/*
 * The line above a notification's title ("Movie Request Approved"), in words
 * each channel can put in its own language: the person's for a notification
 * to one person, the channel's or the server's for a shared channel. The
 * same line in English stays on the notification as `event`, which is what
 * webhooks are sent, so anything reading a webhook sees what it always has.
 *
 * Music has lines of its own rather than another choice in the media ones:
 * a language not yet translated for it would fall back to their "other"
 * choice and call an album a series.
 */
const messages = defineMessages('notifications.events', {
  mediaPending:
    '{kind, select, movie {New Movie Request} movie4k {New 4K Movie Request} tv4k {New 4K Series Request} other {New Series Request}}',
  mediaApproved:
    '{kind, select, movie {Movie Request Approved} movie4k {4K Movie Request Approved} tv4k {4K Series Request Approved} other {Series Request Approved}}',
  mediaAutoApproved:
    '{kind, select, movie {Movie Request Automatically Approved} movie4k {4K Movie Request Automatically Approved} tv4k {4K Series Request Automatically Approved} other {Series Request Automatically Approved}}',
  mediaAutoRequested:
    '{kind, select, movie {Movie Request Automatically Submitted} movie4k {4K Movie Request Automatically Submitted} tv4k {4K Series Request Automatically Submitted} other {Series Request Automatically Submitted}}',
  mediaDeclined:
    '{kind, select, movie {Movie Request Declined} movie4k {4K Movie Request Declined} tv4k {4K Series Request Declined} other {Series Request Declined}}',
  mediaFailed:
    '{kind, select, movie {Movie Request Failed} movie4k {4K Movie Request Failed} tv4k {4K Series Request Failed} other {Series Request Failed}}',
  mediaAvailable:
    '{kind, select, movie {Movie Now Available} movie4k {4K Movie Now Available} tv4k {4K Series Now Available} other {Series Now Available}}',
  requestAvailable:
    '{kind, select, movie {Movie Request Now Available} movie4k {4K Movie Request Now Available} tv4k {4K Series Request Now Available} other {Series Request Now Available}}',
  seriesReadyToWatch: 'Series Ready to Watch',
  musicPending: 'New Music Request',
  musicApproved: 'Music Request Approved',
  musicAutoApproved: 'Music Request Automatically Approved',
  musicAutoRequested: 'Music Request Automatically Submitted',
  musicDeclined: 'Music Request Declined',
  musicFailed: 'Music Request Failed',
  musicAvailable: 'Music Now Available',
  musicRequestAvailable: 'Music Request Now Available',
  issueCreated:
    '{issueType, select, video {New Video Issue Reported} audio {New Audio Issue Reported} subtitles {New Subtitle Issue Reported} other {New Issue Reported}}',
  issueResolved:
    '{issueType, select, video {Video Issue Resolved} audio {Audio Issue Resolved} subtitles {Subtitle Issue Resolved} other {Issue Resolved}}',
  issueReopened:
    '{issueType, select, video {Video Issue Reopened} audio {Audio Issue Reopened} subtitles {Subtitle Issue Reopened} other {Issue Reopened}}',
  issueComment:
    '{issueType, select, video {New Comment on Video Issue} audio {New Comment on Audio Issue} subtitles {New Comment on Subtitle Issue} other {New Comment on Issue}}',
  backfill: 'Backfill',
  health: 'Health',
  wrongMatch: 'Wrong match',
  adminAgent: 'Admin agent',
});

type Intl = ReturnType<typeof getIntl>;
type Message = (typeof messages)[keyof typeof messages];

/** An event line, kept as words to be put in a language when sent. */
export interface EventTitle {
  message: { id: string; defaultMessage: string };
  values?: Record<string, string>;
}

/** What a notification carries about its event line. */
export interface NotificationEvent {
  /** In English, for webhooks and anything else that reads it as data. */
  event: string;
  eventTitle?: EventTitle;
}

/*
 * English straight from the messages above, without the server's locale
 * files: the English line is wanted wherever a notification is made,
 * including before the translations are loaded.
 */
const english = createIntl(
  {
    locale: 'en',
    defaultLocale: 'en',
    messages: Object.fromEntries(
      Object.values(messages).map((m) => [m.id, m.defaultMessage])
    ),
  },
  createIntlCache()
);

const titled = (
  message: Message,
  values?: Record<string, string>
): NotificationEvent => ({
  event: english.formatMessage(message, values),
  eventTitle: { message, values },
});

const MEDIA_MESSAGES: Partial<Record<Notification, Message>> = {
  [Notification.MEDIA_PENDING]: messages.mediaPending,
  [Notification.MEDIA_APPROVED]: messages.mediaApproved,
  [Notification.MEDIA_AUTO_APPROVED]: messages.mediaAutoApproved,
  [Notification.MEDIA_AUTO_REQUESTED]: messages.mediaAutoRequested,
  [Notification.MEDIA_DECLINED]: messages.mediaDeclined,
  [Notification.MEDIA_FAILED]: messages.mediaFailed,
  [Notification.MEDIA_AVAILABLE]: messages.mediaAvailable,
};

const MUSIC_MESSAGES: Partial<Record<Notification, Message>> = {
  [Notification.MEDIA_PENDING]: messages.musicPending,
  [Notification.MEDIA_APPROVED]: messages.musicApproved,
  [Notification.MEDIA_AUTO_APPROVED]: messages.musicAutoApproved,
  [Notification.MEDIA_AUTO_REQUESTED]: messages.musicAutoRequested,
  [Notification.MEDIA_DECLINED]: messages.musicDeclined,
  [Notification.MEDIA_FAILED]: messages.musicFailed,
  [Notification.MEDIA_AVAILABLE]: messages.musicAvailable,
};

const kindOf = (mediaType: MediaType, is4k: boolean) =>
  `${mediaType === MediaType.MOVIE ? 'movie' : 'tv'}${is4k ? '4k' : ''}`;

/** The event line of a request's notification ("4K Movie Request Approved"). */
export const mediaEvent = (
  type: Notification,
  mediaType: MediaType,
  is4k: boolean
): NotificationEvent | undefined => {
  if (mediaType === MediaType.MUSIC) {
    const message = MUSIC_MESSAGES[type];
    return message ? titled(message) : undefined;
  }
  const message = MEDIA_MESSAGES[type];
  return message
    ? titled(message, { kind: kindOf(mediaType, is4k) })
    : undefined;
};

/** "Movie Request Now Available", as said when a request completes. */
export const requestAvailableEvent = (
  mediaType: MediaType,
  is4k: boolean
): NotificationEvent =>
  mediaType === MediaType.MUSIC
    ? titled(messages.musicRequestAvailable)
    : titled(messages.requestAvailable, { kind: kindOf(mediaType, is4k) });

/** An ongoing series that has caught up with what has aired. */
export const seriesReadyToWatchEvent = (): NotificationEvent =>
  titled(messages.seriesReadyToWatch);

const ISSUE_TYPES: Record<IssueType, string> = {
  [IssueType.VIDEO]: 'video',
  [IssueType.AUDIO]: 'audio',
  [IssueType.SUBTITLES]: 'subtitles',
  [IssueType.OTHER]: 'other',
};

const ISSUE_MESSAGES: Partial<Record<Notification, Message>> = {
  [Notification.ISSUE_CREATED]: messages.issueCreated,
  [Notification.ISSUE_RESOLVED]: messages.issueResolved,
  [Notification.ISSUE_REOPENED]: messages.issueReopened,
  [Notification.ISSUE_COMMENT]: messages.issueComment,
};

/** The event line of an issue's notification ("New Video Issue Reported"). */
export const issueEvent = (
  type: Notification,
  issueType: IssueType
): NotificationEvent | undefined => {
  const message = ISSUE_MESSAGES[type];
  return message
    ? titled(message, { issueType: ISSUE_TYPES[issueType] ?? 'other' })
    : undefined;
};

export const backfillEvent = (): NotificationEvent => titled(messages.backfill);
export const healthEvent = (): NotificationEvent => titled(messages.health);
export const wrongMatchEvent = (): NotificationEvent =>
  titled(messages.wrongMatch);
export const adminAgentEvent = (): NotificationEvent =>
  titled(messages.adminAgent);

/**
 * The event line to show, in the language of `intl`: the one the channel has
 * already chosen for the rest of the notification. A line given as plain
 * text (an override, or a list's name) is shown as written.
 */
export const eventText = (
  payload: { event?: string; eventTitle?: EventTitle },
  intl: Intl
): string | undefined =>
  payload.eventTitle
    ? intl.formatMessage(payload.eventTitle.message, payload.eventTitle.values)
    : payload.event;
