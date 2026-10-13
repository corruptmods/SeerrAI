import { IssueType, IssueTypeName } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { defineMessages, getIntl } from '@server/i18n';
import globalMessages from '@server/i18n/globalMessages';
import type { NotificationAgentConfig } from '@server/lib/settings';
import { NotificationAgentKey, getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { AvailableLocale } from '@server/types/languages';
import webpush from 'web-push';
import { Notification, shouldSendAdminNotification } from '..';
import type { NotificationAgent, NotificationPayload } from './agent';
import { BaseAgent } from './agent';

const messages = defineMessages('notifications.agents.webpush', {
  autoRequested: 'Automatically submitted a new {quality}{mediaType} request.',
  approved: 'Your {quality}{mediaType} request has been approved.',
  autoApproved:
    'Automatically approved a new {quality}{mediaType} request from {userName}.',
  available: 'Your {quality}{mediaType} request is now available!',
  downloadedTitleMovie: 'Movie Downloaded',
  downloadedTitleTv: 'TV Show Downloaded',
  downloadedBody: '{title} is ready to play.',
  failedTitleMovie: 'Movie Request Failed',
  failedTitleTv: 'TV Show Request Failed',
  failedBody: '{title} could not be downloaded.',
  declined: 'Your {quality}{mediaType} request was declined.',
  failed: 'Failed to process {quality}{mediaType} request.',
  pending:
    'Approval required for a new {quality}{mediaType} request from {userName}.',
  issueCreated: 'A new {issueType} was reported by {userName}.',
  issueComment: '{userName} commented on the {issueType}.',
  issueResolved: 'The {issueType} was marked as resolved by {userName}!',
  issueReopened: 'The {issueType} was reopened by {userName}.',
  viewIssue: 'View Issue',
  viewMedia: 'View Media',
  approve: 'Approve',
  decline: 'Decline',
  approveFailed: 'Could not approve',
  declineFailed: 'Could not decline',
  actionFailedBody: '{title} — open {applicationTitle} to try again.',
});

interface PushNotificationPayload {
  notificationType: string;
  subject: string;
  message?: string;
  image?: string;
  actionUrl?: string;
  actionUrlTitle?: string;
  requestId?: number;
  pendingRequestsCount?: number;
  isAdmin?: boolean;
  /**
   * The words for the Approve and Decline buttons on a request waiting for
   * approval, and for the notice shown when a tap on one does not go
   * through, in the person's language: the service worker has none of its
   * own.
   */
  actionLabels?: {
    approve: string;
    decline: string;
    approveFailed: string;
    declineFailed: string;
    failedBody: string;
  };
}

interface WebPushError extends Error {
  statusCode?: number;
  status?: number;
  body?: string | unknown;
  response?: {
    body?: string | unknown;
  };
}

/**
 * Decides whether a user should receive a web push notification of this type.
 *
 * A user with no settings row at all defaults to enabled. A user who has a
 * settings row but has never touched the web push types resolves to a bitmask
 * of 0, which would silently opt them out of everything — including the
 * availability notification they registered their device for. Treat that
 * untouched state as enabled too; an explicit non-zero mask is still honoured.
 */
export const wantsWebPush = (
  user: User | undefined,
  type: Notification
): boolean => {
  // A broken sign-in is not something to opt out of: a user who had turned
  // it off would never learn their watchlist had stopped syncing.
  if (type === Notification.PLEX_REAUTH) {
    return true;
  }

  const settings = user?.settings;

  if (!settings) {
    return true;
  }

  const configured = settings.notificationTypes[NotificationAgentKey.WEBPUSH];

  if (configured === undefined || configured === null) {
    return true;
  }

  return settings.hasNotificationType(NotificationAgentKey.WEBPUSH, type);
};

const WEB_PUSH_NOTIFICATION_TYPES: number[] = [
  Notification.MEDIA_AVAILABLE,
  Notification.MEDIA_FAILED,
  Notification.LIST_ACTIVITY,
  Notification.PLEX_REAUTH,
  Notification.BACKFILL,
  Notification.HEALTH,
  Notification.TEST_NOTIFICATION,
];

class WebPushAgent
  extends BaseAgent<NotificationAgentConfig>
  implements NotificationAgent
{
  protected getSettings(): NotificationAgentConfig {
    if (this.settings) {
      return this.settings;
    }

    const settings = getSettings();

    return settings.notifications.agents.webpush;
  }

  private getNotificationPayload(
    type: Notification,
    payload: NotificationPayload,
    locale?: AvailableLocale
  ): PushNotificationPayload {
    const intl = getIntl(locale);
    const { embedPoster } = getSettings().notifications.agents.webpush;

    // Several at once, gathered into one: it says everything itself.
    if (payload.digest) {
      return {
        notificationType: Notification[type],
        subject: payload.subject,
        message: payload.message,
        image: embedPoster ? payload.image : undefined,
        actionUrl: payload.actionUrl,
        actionUrlTitle: payload.actionUrlTitle,
      };
    }

    const mediaType = payload.media
      ? payload.media.mediaType === MediaType.MOVIE
        ? intl.formatMessage(globalMessages.movie)
        : intl.formatMessage(globalMessages.series)
      : undefined;
    const is4k = payload.request?.is4k;
    const quality = is4k ? '4K ' : '';

    const issueType = payload.issue
      ? payload.issue.issueType !== IssueType.OTHER
        ? intl.formatMessage(globalMessages.issueTypeName, {
            type: IssueTypeName[payload.issue.issueType].toLowerCase(),
          })
        : intl.formatMessage(globalMessages.issue)
      : undefined;

    let message: string | undefined;
    switch (type) {
      case Notification.TEST_NOTIFICATION:
        message = payload.message;
        break;
      // List activity supplies its own sentence, e.g. "Jordan added Dune."
      case Notification.LIST_ACTIVITY:
        message = payload.message;
        break;
      case Notification.PLEX_REAUTH:
        message = payload.message;
        break;
      // Backfill supplies its own sentence and the page to open.
      case Notification.BACKFILL:
      case Notification.HEALTH:
        message = payload.message;
        break;
      case Notification.MEDIA_AUTO_REQUESTED:
        message = intl.formatMessage(messages.autoRequested, {
          quality,
          mediaType,
        });
        break;
      case Notification.MEDIA_APPROVED: {
        message = intl.formatMessage(messages.approved, {
          quality,
          mediaType,
        });
        // Push shows no extra fields, so the estimate goes in the message.
        const expected = payload.extra?.find(
          (field) => field.name === 'Expected'
        )?.value;
        if (expected) {
          message = `${message} ${expected}.`;
        }
        break;
      }
      case Notification.MEDIA_AUTO_APPROVED:
        message = intl.formatMessage(messages.autoApproved, {
          quality,
          mediaType,
          userName: payload.request?.requestedBy.displayName,
        });
        break;
      case Notification.MEDIA_AVAILABLE:
        message = intl.formatMessage(messages.available, {
          quality,
          mediaType,
        });
        break;
      case Notification.MEDIA_DECLINED:
        message = intl.formatMessage(messages.declined, {
          quality,
          mediaType,
        });
        break;
      case Notification.MEDIA_FAILED:
        message = intl.formatMessage(messages.failed, {
          quality,
          mediaType,
        });
        break;
      case Notification.MEDIA_PENDING:
        message = intl.formatMessage(messages.pending, {
          quality,
          mediaType,
          userName: payload.request?.requestedBy.displayName,
        });
        break;
      case Notification.ISSUE_CREATED:
        message = intl.formatMessage(messages.issueCreated, {
          issueType,
          userName: payload.issue?.createdBy.displayName,
        });
        break;
      case Notification.ISSUE_COMMENT:
        message = intl.formatMessage(messages.issueComment, {
          userName: payload.comment?.user.displayName,
          issueType,
        });
        break;
      case Notification.ISSUE_RESOLVED:
        message = intl.formatMessage(messages.issueResolved, {
          issueType,
          userName: payload.issue?.modifiedBy?.displayName,
        });
        break;
      case Notification.ISSUE_REOPENED:
        message = intl.formatMessage(messages.issueReopened, {
          issueType,
          userName: payload.issue?.modifiedBy?.displayName,
        });
        break;
      default:
        return {
          notificationType: Notification[type],
          subject: 'Unknown',
        };
    }

    const actionUrl =
      payload.actionUrl ??
      (payload.issue
        ? `/issues/${payload.issue.id}`
        : payload.media
          ? `/${payload.media.mediaType}/${payload.media.tmdbId}`
          : undefined);

    const actionUrlTitle = payload.actionUrl
      ? payload.actionUrlTitle
      : actionUrl
        ? intl.formatMessage(
            payload.issue ? messages.viewIssue : messages.viewMedia
          )
        : undefined;

    const isTv = payload.media?.mediaType === MediaType.TV;

    // Availability and failure notifications lead with what happened and put
    // the title in the body, which reads better in a phone notification than
    // a bare title followed by a plot synopsis.
    let subject = payload.subject;

    if (type === Notification.MEDIA_AVAILABLE && payload.subject) {
      subject = intl.formatMessage(
        isTv ? messages.downloadedTitleTv : messages.downloadedTitleMovie
      );
      message = intl.formatMessage(messages.downloadedBody, {
        title: payload.subject,
      });
    } else if (type === Notification.MEDIA_FAILED && payload.subject) {
      subject = intl.formatMessage(
        isTv ? messages.failedTitleTv : messages.failedTitleMovie
      );
      message = intl.formatMessage(messages.failedBody, {
        title: payload.subject,
      });
    }

    return {
      notificationType: Notification[type],
      subject,
      message,
      image: embedPoster ? payload.image : undefined,
      requestId: payload.request?.id,
      actionUrl,
      actionUrlTitle,
      pendingRequestsCount: payload.pendingRequestsCount,
      isAdmin: payload.isAdmin,
      actionLabels:
        type === Notification.MEDIA_PENDING
          ? {
              approve: intl.formatMessage(messages.approve),
              decline: intl.formatMessage(messages.decline),
              approveFailed: intl.formatMessage(messages.approveFailed),
              declineFailed: intl.formatMessage(messages.declineFailed),
              failedBody: intl.formatMessage(messages.actionFailedBody, {
                title: subject ?? '',
                applicationTitle: getSettings().main.applicationTitle,
              }),
            }
          : undefined,
    };
  }

  public shouldSend(): boolean {
    if (this.getSettings().enabled) {
      return true;
    }

    return false;
  }

  public async send(
    type: Notification,
    payload: NotificationPayload
  ): Promise<boolean> {
    // Web push is scoped to availability and failure notifications only. Test
    // notifications are allowed through so the agent can still be verified
    // from the settings page.
    if (!WEB_PUSH_NOTIFICATION_TYPES.includes(type)) {
      return true;
    }

    const userRepository = getRepository(User);
    const userPushSubRepository = getRepository(UserPushSubscription);
    const settings = getSettings();

    const pushSubs: { sub: UserPushSubscription; locale?: AvailableLocale }[] =
      [];

    const mainUser = await userRepository.findOne({ where: { id: 1 } });

    const webPushNotification = async (
      pushSub: UserPushSubscription,
      notificationPayload: Buffer
    ) => {
      logger.debug('Sending web push notification', {
        label: 'Notifications',
        recipient: pushSub.user.displayName,
        type: Notification[type],
        subject: payload.subject,
      });

      try {
        await webpush.sendNotification(
          {
            endpoint: pushSub.endpoint,
            keys: {
              auth: pushSub.auth,
              p256dh: pushSub.p256dh,
            },
          },
          notificationPayload
        );
      } catch (e) {
        const webPushError = e as WebPushError;
        const statusCode = webPushError.statusCode || webPushError.status;
        const errorMessage = webPushError.message || String(e);

        // RFC 8030: 410/404 are permanent failures, others are transient
        const isPermanentFailure = statusCode === 410 || statusCode === 404;

        logger.error(
          isPermanentFailure
            ? 'Error sending web push notification; removing invalid subscription'
            : 'Error sending web push notification (transient error, keeping subscription)',
          {
            label: 'Notifications',
            recipient: pushSub.user.displayName,
            type: Notification[type],
            subject: payload.subject,
            errorMessage,
            statusCode: statusCode || 'unknown',
          }
        );

        if (isPermanentFailure) {
          await userPushSubRepository.remove(pushSub);
        }
      }
    };

    if (
      payload.notifyUser &&
      !payload.holdUser &&
      wantsWebPush(payload.notifyUser, type)
    ) {
      const notifySubs = await userPushSubRepository.find({
        where: { user: { id: payload.notifyUser.id } },
      });

      pushSubs.push(
        ...notifySubs.map((sub) => ({
          sub,
          locale: payload.notifyUser?.settings?.locale as AvailableLocale,
        }))
      );
    }

    // Approvals and declines used to send every admin an extra push that only
    // updated the app badge and showed nothing. Browsers require a push to
    // show a notification: WebKit revokes the subscription of an app that
    // does not, so on an iPhone those pushes cost the admin their
    // notifications. The app refreshes the badge itself whenever it is
    // opened or focused, so they are no longer sent.
    if (payload.notifyAdmin) {
      const users = await userRepository.find();

      const manageUsers = users.filter(
        (user) =>
          wantsWebPush(user, type) &&
          shouldSendAdminNotification(type, user, payload)
      );

      const allSubs =
        manageUsers.length > 0
          ? await userPushSubRepository
              .createQueryBuilder('pushSub')
              .leftJoinAndSelect('pushSub.user', 'user')
              .leftJoinAndSelect('user.settings', 'settings')
              .where('pushSub.userId IN (:...users)', {
                users: manageUsers.map((user) => user.id),
              })
              .getMany()
          : [];

      pushSubs.push(
        ...allSubs.map((sub) => ({
          sub,
          locale: sub.user?.settings?.locale as AvailableLocale,
        }))
      );
    }

    if (mainUser && pushSubs.length > 0) {
      webpush.setVapidDetails(
        `mailto:${mainUser.email}`,
        settings.vapidPublic,
        settings.vapidPrivate
      );

      await Promise.all(
        pushSubs.map(async ({ sub, locale }) => {
          const notificationPayload = Buffer.from(
            JSON.stringify(this.getNotificationPayload(type, payload, locale)),
            'utf-8'
          );
          await webPushNotification(sub, notificationPayload);
        })
      );
    }

    return true;
  }
}

export default WebPushAgent;
