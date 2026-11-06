import { MediaType } from '@server/constants/media';
import type { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import logger from '@server/logger';
import type { NotificationAgent, NotificationPayload } from './agents/agent';
import { declineReasonOf } from './declineReason';

export enum Notification {
  NONE = 0,
  MEDIA_PENDING = 2,
  MEDIA_APPROVED = 4,
  MEDIA_AVAILABLE = 8,
  MEDIA_FAILED = 16,
  TEST_NOTIFICATION = 32,
  MEDIA_DECLINED = 64,
  MEDIA_AUTO_APPROVED = 128,
  ISSUE_CREATED = 256,
  ISSUE_COMMENT = 512,
  ISSUE_RESOLVED = 1024,
  ISSUE_REOPENED = 2048,
  MEDIA_AUTO_REQUESTED = 4096,
  LIST_ACTIVITY = 8192,
  /** Plex rejected the user's token; watchlist sync stopped. Always sent. */
  PLEX_REAUTH = 16384,
  /** Backfill pack awaiting approval, finished or failed. Admins only. */
  BACKFILL = 32768,
  /** A Health page problem that appeared and persisted. Admins only. */
  HEALTH = 65536,
  /**
   * A new import matched the wrong title or none (lib/matchWatch). Admins
   * only; sent once.
   */
  WRONG_MATCH = 131072,
  /** An imported playlist has missing songs or became unreadable. User only. */
  PLAYLIST_UPDATE = 262144,
  /** The requester's copy of MEDIA_FAILED, which they can turn off. */
  REQUEST_FAILED = 524288,
  /**
   * Maintainerr will soon delete the user's request; once per date. User only.
   */
  LEAVING_SOON = 1048576,
  /**
   * A series the person follows got a new season, started one, or ended.
   * User only.
   */
  FOLLOWED_SERIES = 2097152,
}

/** Default web push types; approvals, declines and issues are opt-in. */
export const WEB_PUSH_STARTING_TYPES =
  Notification.MEDIA_AVAILABLE |
  Notification.MEDIA_FAILED |
  Notification.REQUEST_FAILED |
  Notification.LIST_ACTIVITY |
  Notification.PLAYLIST_UPDATE |
  Notification.LEAVING_SOON |
  Notification.FOLLOWED_SERIES |
  Notification.PLEX_REAUTH |
  Notification.BACKFILL |
  Notification.HEALTH |
  Notification.WRONG_MATCH |
  Notification.TEST_NOTIFICATION;

export const hasNotificationType = (
  types: Notification | Notification[],
  value: number
): boolean => {
  if (types === 0) {
    return true;
  }

  const total = Array.isArray(types) ? types.reduce((a, v) => a + v, 0) : types;

  // Test notifications don't need to be enabled
  if (!(value & Notification.TEST_NOTIFICATION)) {
    value += Notification.TEST_NOTIFICATION;
  }

  return !!(value & total);
};

export const getAdminPermission = (type: Notification): Permission => {
  switch (type) {
    case Notification.MEDIA_PENDING:
    case Notification.MEDIA_APPROVED:
    case Notification.MEDIA_AVAILABLE:
    case Notification.MEDIA_FAILED:
    case Notification.MEDIA_DECLINED:
    case Notification.MEDIA_AUTO_APPROVED:
      return Permission.MANAGE_REQUESTS;
    case Notification.ISSUE_CREATED:
    case Notification.ISSUE_COMMENT:
    case Notification.ISSUE_RESOLVED:
    case Notification.ISSUE_REOPENED:
      return Permission.MANAGE_ISSUES;
    default:
      return Permission.ADMIN;
  }
};

export const shouldSendAdminNotification = (
  type: Notification,
  user: User,
  payload: NotificationPayload
): boolean => {
  return (
    user.id !== payload.notifyUser?.id &&
    // Admins already got each item in a digest.
    !payload.digest &&
    user.hasPermission(getAdminPermission(type)) &&
    // Skip whoever caused it: the requester (for themself or another),
    // issue creator, commenter or resolver.
    (type !== Notification.MEDIA_AUTO_APPROVED ||
      user.id !==
        (payload.request?.modifiedBy ?? payload.request?.requestedBy)?.id) &&
    (type !== Notification.ISSUE_CREATED ||
      user.id !== payload.issue?.createdBy.id) &&
    (type !== Notification.ISSUE_COMMENT ||
      user.id !== payload.comment?.user.id) &&
    ((type !== Notification.ISSUE_RESOLVED &&
      type !== Notification.ISSUE_REOPENED) ||
      user.id !== payload.issue?.modifiedBy?.id)
  );
};

/**
 * User notification types batched into a digest when several arrive together.
 */
const GATHERED = new Set<Notification>([
  Notification.MEDIA_AVAILABLE,
  Notification.MEDIA_APPROVED,
  Notification.MEDIA_AUTO_APPROVED,
  Notification.MEDIA_DECLINED,
  Notification.MEDIA_AUTO_REQUESTED,
]);

/** Titles named in a gathered notification before "and N more". */
const NAMED_IN_DIGEST = 6;

interface Gathering {
  type: Notification;
  payloads: NotificationPayload[];
  firstAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

const digestSubject = (
  type: Notification,
  payloads: NotificationPayload[]
): string => {
  const count = payloads.length;
  switch (type) {
    case Notification.MEDIA_AVAILABLE: {
      // Say "listen" when some or all are music.
      const music = payloads.filter(
        (p) => p.media?.mediaType === MediaType.MUSIC
      ).length;
      return music === count
        ? `${count} music requests are ready to listen to`
        : music
          ? `${count} requests are ready to watch or listen to`
          : `${count} titles are ready to watch`;
    }
    case Notification.MEDIA_DECLINED:
      return `${count} requests were declined`;
    case Notification.MEDIA_AUTO_REQUESTED:
      return `${count} titles were requested from your watchlist`;
    default:
      return `${count} requests were approved`;
  }
};

/** Combines several same-type payloads into one user notification. */
export const digestOf = (
  type: Notification,
  payloads: NotificationPayload[]
): NotificationPayload => {
  const names = payloads.map((p) => p.subject);
  const shown = names.slice(0, NAMED_IN_DIGEST);
  const more = names.length - shown.length;
  return {
    subject: digestSubject(type, payloads),
    message: `${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`,
    image: payloads.find((p) => p.image)?.image,
    notifyUser: payloads[0].notifyUser,
    notifySystem: false,
    notifyAdmin: false,
    digest: true,
    actionUrl: '/requests',
    actionUrlTitle: 'View Requests',
  };
};

class NotificationManager {
  private activeAgents: NotificationAgent[] = [];
  private gatherings = new Map<string, Gathering>();
  /**
   * A digest sends `quietMs` after its last item, at most `longestMs` after its
   * first.
   */
  public gathering = { quietMs: 90_000, longestMs: 5 * 60_000 };

  public registerAgents = (agents: NotificationAgent[]): void => {
    this.activeAgents = [...this.activeAgents, ...agents];
    logger.info('Registered notification agents', { label: 'Notifications' });
  };

  public sendNotification(
    type: Notification,
    payload: NotificationPayload
  ): void {
    logger.info(`Sending notification(s) for ${Notification[type]}`, {
      label: 'Notifications',
      subject: payload.subject,
    });

    // The requester gets REQUEST_FAILED, toggled apart from the admin copy.
    if (
      type === Notification.MEDIA_FAILED &&
      payload.notifyUser &&
      !payload.holdUser &&
      !payload.digest
    ) {
      if (payload.notifySystem || payload.notifyAdmin) {
        this.deliver(type, { ...payload, holdUser: true });
      }
      this.deliver(Notification.REQUEST_FAILED, {
        ...payload,
        notifySystem: false,
        notifyAdmin: false,
      });
      return;
    }

    // A decline with a reason is never batched; a digest would drop the reason.
    if (
      !GATHERED.has(type) ||
      !payload.notifyUser ||
      payload.digest ||
      declineReasonOf(type, payload)
    ) {
      this.deliver(type, payload);
      return;
    }

    // Admins and channels get it now; the user's copy is batched.
    if (payload.notifySystem || payload.notifyAdmin) {
      this.deliver(type, { ...payload, holdUser: true });
    }
    this.gather(type, {
      ...payload,
      notifySystem: false,
      notifyAdmin: false,
    });
  }

  private deliver(type: Notification, payload: NotificationPayload): void {
    // Sends are not awaited; an uncaught rejection would stop the server.
    const failed = (agent: NotificationAgent, e: unknown) =>
      logger.error('A notification agent failed to send', {
        label: 'Notifications',
        agent: agent.constructor?.name,
        type: Notification[type],
        subject: payload.subject,
        errorMessage: e instanceof Error ? e.message : String(e),
      });

    this.activeAgents.forEach((agent) => {
      try {
        if (agent.shouldSend()) {
          Promise.resolve(agent.send(type, payload)).catch((e) =>
            failed(agent, e)
          );
        }
      } catch (e) {
        failed(agent, e);
      }
    });
  }

  private gather(type: Notification, payload: NotificationPayload): void {
    const key = `${type}:${payload.notifyUser!.id}`;
    const now = Date.now();
    const gathering = this.gatherings.get(key) ?? {
      type,
      payloads: [],
      firstAt: now,
    };
    gathering.payloads.push(payload);
    this.gatherings.set(key, gathering);
    if (gathering.timer) {
      clearTimeout(gathering.timer);
    }
    const wait = Math.max(
      0,
      Math.min(
        this.gathering.quietMs,
        gathering.firstAt + this.gathering.longestMs - now
      )
    );
    gathering.timer = setTimeout(() => this.release(key), wait);
  }

  private release(key: string): void {
    const gathering = this.gatherings.get(key);
    this.gatherings.delete(key);
    if (!gathering) {
      return;
    }
    const { type } = gathering;
    // Dedupe by request: one request can fire twice as it completes, but
    // separate requests for one series stay separate.
    const sameThing = (p: NotificationPayload) =>
      p.request?.id != null
        ? `request:${p.request.id}`
        : `${p.media?.id ?? p.subject}:${p.request?.is4k}`;
    const payloads = gathering.payloads.filter(
      (p, i, all) => all.findIndex((q) => sameThing(q) === sameThing(p)) === i
    );
    if (payloads.length === 1) {
      this.deliver(type, payloads[0]);
      return;
    }
    logger.info(
      `Sending ${payloads.length} ${Notification[type]} notifications as one`,
      { label: 'Notifications', userId: payloads[0].notifyUser?.id }
    );
    this.deliver(type, digestOf(type, payloads));
  }

  /** Sends all pending digests now, e.g. on shutdown. */
  public flush(): void {
    for (const [key, gathering] of this.gatherings) {
      if (gathering.timer) {
        clearTimeout(gathering.timer);
      }
      this.release(key);
    }
  }
}

const notificationManager = new NotificationManager();

export default notificationManager;
