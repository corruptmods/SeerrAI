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
   * The line above the title, in English. Webhooks are sent this; the other
   * channels show `eventTitle` in their own language when there is one.
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
   * An in-app path to open, for notifications about something other than a
   * title or an issue (Backfill's approval page).
   */
  actionUrl?: string;
  actionUrlTitle?: string;
  /**
   * The person's own copy is held back, to be sent with others like it as
   * one; the admin and channel copies still go.
   */
  holdUser?: boolean;
  /** Several notifications gathered into one, for the person alone. */
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
