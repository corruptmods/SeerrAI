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
  /**
   * Plex rejected the user's token, so their watchlist has stopped syncing.
   * Account health rather than a preference: always sent, never a toggle.
   */
  PLEX_REAUTH = 16384,
  /**
   * Backfill found a pack waiting for approval, or finished or failed one.
   * Admins only; tapping it opens the page to approve or skip it.
   */
  BACKFILL = 32768,
  /**
   * Something on the Health page newly went wrong with a connected service
   * and stayed wrong: a service down, an indexer or subtitle provider
   * paused, a disk filling up. Admins only; opens the Health page.
   */
  HEALTH = 65536,
  /**
   * A media server matched a title just requested and imported to another
   * title, or not at all (lib/matchWatch). Admins only; told once.
   */
  WRONG_MATCH = 131072,
}

export const hasNotificationType = (
  types: Notification | Notification[],
  value: number
): boolean => {
  let total: number;

  // If we are not checking any notifications, bail out and return true
  if (types === 0) {
    return true;
  }

  if (Array.isArray(types)) {
    // Combine all notification values into one
    total = types.reduce((a, v) => a + v, 0);
  } else {
    total = types;
  }

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
    // A digest is for the person it gathers; admins had each one already.
    !payload.digest &&
    user.hasPermission(getAdminPermission(type)) &&
    // Check if the user submitted this request (on behalf of themself OR another user)
    (type !== Notification.MEDIA_AUTO_APPROVED ||
      user.id !==
        (payload.request?.modifiedBy ?? payload.request?.requestedBy)?.id) &&
    // Check if the user created this issue
    (type !== Notification.ISSUE_CREATED ||
      user.id !== payload.issue?.createdBy.id) &&
    // Check if the user submitted this issue comment
    (type !== Notification.ISSUE_COMMENT ||
      user.id !== payload.comment?.user.id) &&
    // Check if the user resolved/reopened this issue
    ((type !== Notification.ISSUE_RESOLVED &&
      type !== Notification.ISSUE_REOPENED) ||
      user.id !== payload.issue?.modifiedBy?.id)
  );
};

/**
 * What a person is told about their requests, gathered when several come
 * at once: eight films arriving together are one "8 titles are ready to
 * watch", not eight notifications in a minute.
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

/** The headline of a gathered notification, by kind. */
const digestSubject = (type: Notification, count: number): string => {
  switch (type) {
    case Notification.MEDIA_AVAILABLE:
      return `${count} titles are ready to watch`;
    case Notification.MEDIA_DECLINED:
      return `${count} requests were declined`;
    case Notification.MEDIA_AUTO_REQUESTED:
      return `${count} titles were requested from your watchlist`;
    default:
      return `${count} requests were approved`;
  }
};

/** One notification for several of a kind, for the person they are about. */
export const digestOf = (
  type: Notification,
  payloads: NotificationPayload[]
): NotificationPayload => {
  const names = payloads.map((p) => p.subject);
  const shown = names.slice(0, NAMED_IN_DIGEST);
  const more = names.length - shown.length;
  return {
    subject: digestSubject(type, payloads.length),
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
   * A person's notifications of a kind go out this long after the last of
   * a burst, and no later than `longestMs` after the first.
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

    // A decline that came with a reason goes on its own too: the reason was
    // written for that request, and a summary of several would lose it.
    if (
      !GATHERED.has(type) ||
      !payload.notifyUser ||
      payload.digest ||
      declineReasonOf(type, payload)
    ) {
      this.deliver(type, payload);
      return;
    }

    // Admins and channels are told now; the person's own copy waits for
    // any others like it.
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
    // Each agent's failure is caught and logged here. Nothing waits for a
    // send, so one that failed (a service down, a database read) would
    // otherwise be an unhandled rejection, which stops the whole server.
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
    // The same request twice in one burst (it can be told about twice as it
    // completes) is told once. Two requests for one series, its first and
    // second seasons say, are two things to tell.
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

  /** Sends everything gathered now, as when the server is stopping. */
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
