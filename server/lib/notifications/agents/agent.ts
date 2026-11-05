import type Issue from '@server/entity/Issue';
import type IssueComment from '@server/entity/IssueComment';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import type { EventTitle } from '@server/lib/notifications/eventTitles';
import type { NotificationAgentConfig } from '@server/lib/settings';
import type { Notification } from '..';

export interface NotificationPayload {
  /**
   * English event line, sent to webhooks; other channels localize `eventTitle`.
   */
  event?: string;
  eventTitle?: EventTitle;
  subject: string;
  notifySystem: boolean;
  notifyAdmin: boolean;
  notifyUser?: User;
  media?: Media;
  image?: string;
  message?: string;
  extra?: { name: string; value: string }[];
  request?: MediaRequest;
  issue?: Issue;
  comment?: IssueComment;
  pendingRequestsCount?: number;
  isAdmin?: boolean;
  /**
   * In-app path for notifications not about a title or issue (e.g. Backfill
   * approval).
   */
  actionUrl?: string;
  actionUrlTitle?: string;
  /**
   * Skip the user's copy (it goes in a digest); admin and channel copies still
   * send.
   */
  holdUser?: boolean;
  /** A user-only digest of several notifications. */
  digest?: boolean;
}

export abstract class BaseAgent<T extends NotificationAgentConfig> {
  protected settings?: T;
  public constructor(settings?: T) {
    this.settings = settings;
  }

  protected abstract getSettings(): T;
}

export interface NotificationAgent {
  shouldSend(): boolean;
  send(type: Notification, payload: NotificationPayload): Promise<boolean>;
}
