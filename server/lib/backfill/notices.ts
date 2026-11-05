import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { backfillEvent } from '@server/lib/notifications/eventTitles';
import logger from '@server/logger';

/*
 * Batches Backfill and admin agent notices to admins: a notice waits until
 * things are quiet for a while (at most `longestMs` after the first), then
 * everything since goes out as one, grouped by title. Ten episodes of one
 * show finishing in a minute are one notification, not ten.
 *
 * Only an agent question, which needs someone now, goes out at once.
 */

export type NoticeKind =
  /** A download imported. */
  | 'finished'
  /** A download failed and nothing replaced it. */
  | 'failed'
  /** A download failed and another pack replaced it automatically. */
  | 'replaced'
  /** A pack waits for an admin's approval. */
  | 'found'
  /** The admin agent started, stopped or requested something. */
  | 'agent';

export interface Notice {
  kind: NoticeKind;
  /** Backfill title row, for grouping and links. */
  seriesId: number;
  title: string;
  poster?: string | null;
  /** What it was about: "S17E02", "the movie", or a pack name. */
  what: string;
  /** The failure reason, or the agent's action. */
  detail?: string;
  /** Link used when this is the only notice. */
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

/** A batch of notices as one notification. */
export const summarize = (notices: Notice[]): NotificationPayload => {
  const titles = [...new Set(notices.map((n) => n.seriesId))];
  const base = {
    ...backfillEvent(),
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
  const waiting = notices.filter((n) => n.kind === 'found');
  const kinds = byKind(notices);
  if (titles.length === 1) {
    const [first] = notices;
    return {
      ...base,
      subject: `${first.title}: ${kinds
        .map(([kind, list]) => counted(kind, list.length))
        .join(', ')}`,
      message: kinds
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
      // One waiting pack links to itself; several to the title's review.
      actionUrl:
        waiting.length === 1
          ? waiting[0].url
          : waiting.length
            ? `/backfill/series/${first.seriesId}#review`
            : `/backfill/series/${first.seriesId}`,
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
    subject: `Backfill: ${kinds
      .map(([kind, list]) => counted(kind, list.length))
      .join(', ')}`,
    message:
      perTitle.slice(0, 8).join('\n') +
      (perTitle.length > 8 ? `\n…and ${perTitle.length - 8} more titles` : ''),
    // Waiting packs link to Backfill's awaiting list.
    actionUrl: waiting.length ? '/backfill#awaiting' : '/backfill',
    actionUrlTitle: 'Open Backfill',
  };
};

class BackfillNotices {
  private pending: Notice[] = [];
  private firstAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  /**
   * Sends after `quietMs` with nothing new, at most `longestMs` after the
   * first held notice.
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

  /** Sends what is held now, e.g. on shutdown. */
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

  /** Held notices, for tests. */
  public held(): readonly Notice[] {
    return this.pending;
  }
}

const backfillNotices = new BackfillNotices();
export default backfillNotices;
