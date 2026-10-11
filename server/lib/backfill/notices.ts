import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import logger from '@server/logger';

/*
 * Backfill and the admin agent tell admins what happened, gathered: a
 * notice waits until things have been quiet for a while (or for at most
 * `longestMs` after the first), and then everything since goes out as one,
 * grouped by title. Ten episodes of one show finishing in a minute are one
 * notification, not ten.
 *
 * Only what needs someone right now goes out at once: a question from the
 * agent.
 */

export type NoticeKind =
  /** A download imported. */
  | 'finished'
  /** A download failed, and nothing took its place. */
  | 'failed'
  /** A download failed, and another pack took its place on its own. */
  | 'replaced'
  /** A pack waits for an admin's approval. */
  | 'found'
  /** The admin agent started, stopped or requested something. */
  | 'agent';

export interface Notice {
  kind: NoticeKind;
  /** Backfill's title row, to group by and link to. */
  seriesId: number;
  title: string;
  poster?: string | null;
  /** "S17E02", "the movie", or a pack's name: what it was about. */
  what: string;
  /** Why, for a failure; what it did, for the agent. */
  detail?: string;
  /** Where the notice for this one alone would link. */
  url: string;
}

const VERB: Record<NoticeKind, [string, string]> = {
  finished: ['download finished', 'downloads finished'],
  failed: ['download failed', 'downloads failed'],
  replaced: ['failed download was replaced', 'failed downloads were replaced'],
  found: ['pack waits for approval', 'packs wait for approval'],
  agent: ['change by the admin agent', 'changes by the admin agent'],
};
const ORDER: NoticeKind[] = [
  'failed',
  'found',
  'finished',
  'replaced',
  'agent',
];

const counted = (kind: NoticeKind, n: number) =>
  `${n} ${VERB[kind][n === 1 ? 0 : 1]}`;

/** "S17E02, S17E03 and 4 more". */
const listOf = (items: string[], shown = 6) => {
  const unique = [...new Set(items.filter(Boolean))];
  if (unique.length <= shown) {
    return unique.length > 1
      ? `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`
      : (unique[0] ?? '');
  }
  return `${unique.slice(0, shown).join(', ')} and ${unique.length - shown} more`;
};

const byKind = (notices: Notice[]) => {
  const groups = new Map<NoticeKind, Notice[]>();
  for (const n of notices) {
    groups.set(n.kind, [...(groups.get(n.kind) ?? []), n]);
  }
  return ORDER.filter((k) => groups.has(k)).map(
    (k) => [k, groups.get(k)!] as const
  );
};

/** What a batch of notices says, as one notification. */
export const summarize = (notices: Notice[]): NotificationPayload => {
  const titles = [...new Set(notices.map((n) => n.seriesId))];
  const base = {
    event: 'Backfill',
    notifyAdmin: true,
    notifySystem: true,
  };
  if (notices.length === 1) {
    const [n] = notices;
    return {
      ...base,
      subject: `${n.title}: ${VERB[n.kind][0]}`,
      message: [n.what, n.detail].filter(Boolean).join(': '),
      image: n.poster ?? undefined,
      actionUrl: n.url,
      actionUrlTitle: 'Open',
    };
  }
  if (titles.length === 1) {
    const [first] = notices;
    return {
      ...base,
      subject: `${first.title}: ${byKind(notices)
        .map(([kind, list]) => counted(kind, list.length))
        .join(', ')}`,
      message: byKind(notices)
        .map(([kind, list]) => {
          const reasons =
            kind === 'failed'
              ? ` (${listOf(
                  list.map((n) => n.detail ?? ''),
                  2
                )})`
              : '';
          return `${VERB[kind][list.length === 1 ? 0 : 1].replace(/^./, (c) =>
            c.toUpperCase()
          )}: ${listOf(list.map((n) => n.what))}${reasons}.`;
        })
        .join('\n'),
      image: notices.find((n) => n.poster)?.poster ?? undefined,
      actionUrl: `/backfill/series/${first.seriesId}`,
      actionUrlTitle: 'Open',
    };
  }
  const perTitle = titles.map((id) => {
    const mine = notices.filter((n) => n.seriesId === id);
    return `${mine[0].title}: ${byKind(mine)
      .map(([kind, list]) => counted(kind, list.length))
      .join(', ')}`;
  });
  return {
    ...base,
    subject: `Backfill: ${byKind(notices)
      .map(([kind, list]) => counted(kind, list.length))
      .join(', ')}`,
    message:
      perTitle.slice(0, 8).join('\n') +
      (perTitle.length > 8 ? `\n…and ${perTitle.length - 8} more titles` : ''),
    actionUrl: '/backfill',
    actionUrlTitle: 'Open Backfill',
  };
};

class BackfillNotices {
  private pending: Notice[] = [];
  private firstAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  /**
   * Sent once nothing new came for `quietMs`, and never later than
   * `longestMs` after the first held notice.
   */
  public timing = { quietMs: 10 * 60_000, longestMs: 30 * 60_000 };

  public add(notice: Notice): void {
    const now = Date.now();
    if (!this.pending.length) this.firstAt = now;
    this.pending.push(notice);
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(
      0,
      Math.min(this.timing.quietMs, this.firstAt + this.timing.longestMs - now)
    );
    this.timer = setTimeout(() => this.flush(), wait);
    this.timer.unref?.();
  }

  /** Sends what is held now, as when the server stops. */
  public flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const notices = this.pending;
    this.pending = [];
    if (!notices.length) return;
    try {
      notificationManager.sendNotification(
        Notification.BACKFILL,
        summarize(notices)
      );
    } catch (e) {
      logger.warn('Could not send Backfill notices', {
        label: 'Backfill',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** What is held, for tests. */
  public held(): readonly Notice[] {
    return this.pending;
  }
}

const backfillNotices = new BackfillNotices();
export default backfillNotices;
