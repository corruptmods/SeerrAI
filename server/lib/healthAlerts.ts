import type { HealthCheck } from '@server/lib/health';
import { serviceChecks } from '@server/lib/health';
import notificationManager, { Notification } from '@server/lib/notifications';
import { healthEvent } from '@server/lib/notifications/eventTitles';
import logger from '@server/logger';

/*
 * Notifies admins when a connected service on the Health page newly has a
 * problem (a paused WhisperAI, an indexer Prowlarr disabled).
 *
 * Sent once after two runs in a row (a brief timeout isn't worth an alert),
 * and not again until it clears. State is in memory, so a restart re-sends
 * ongoing problems once.
 */

/** Consecutive runs a problem must appear on before alerting. */
export const RUNS_BEFORE_TELLING = 2;
/** Problems named in one notification before "and N more". */
const NAMED = 5;

export interface HealthProblem {
  key: string;
  service: string;
  title: string;
  detail?: string;
}

/** One problem per thing wrong in the service checks. */
export const problemsIn = (checks: HealthCheck[]): HealthProblem[] =>
  checks.flatMap((check) => {
    const service = check.name ?? check.id;
    if (check.status === 'ok') return [];
    // Unreachable or no items: a single problem.
    if (!check.reachable || !check.items.length) {
      return [
        {
          key: `${check.id}:down`,
          service,
          title: 'Not answering',
          detail: check.detail,
        },
      ];
    }
    return check.items.map((item) => ({
      key: `${check.id}:${item.title}`,
      service,
      title: item.title,
      detail: item.detail,
    }));
  });

class HealthAlerts {
  /** Consecutive runs each problem has been seen on. */
  private seen = new Map<string, number>();
  /** Problems alerted, until they clear. */
  private told = new Set<string>();
  private running = false;

  /** Runs the checks once and alerts on new problems. */
  public async run(): Promise<HealthProblem[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const checks = await serviceChecks();
      return this.consider(
        problemsIn(checks),
        new Set(
          checks.filter((check) => check.partial).map((check) => check.id)
        )
      );
    } catch (e) {
      logger.warn('Could not run the health checks for alerts', {
        label: 'Health',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return [];
    } finally {
      this.running = false;
    }
  }

  /**
   * Sends and returns the problems newly due for an alert. `unread` lists
   * services that answered but whose report couldn't be fully read: their
   * known problems stand instead of clearing and re-alerting next run.
   */
  public consider(
    problems: HealthProblem[],
    unread: ReadonlySet<string> = new Set()
  ): HealthProblem[] {
    const now = new Set(problems.map((p) => p.key));
    // It answered, so a previous ":down" has cleared.
    const ofUnread = (key: string) =>
      [...unread].some(
        (id) => key.startsWith(`${id}:`) && key !== `${id}:down`
      );
    for (const key of [...this.seen.keys()]) {
      if (!now.has(key) && !ofUnread(key)) {
        // Cleared: alert again if it recurs.
        this.seen.delete(key);
        this.told.delete(key);
      }
    }
    const fresh = problems.filter((p) => {
      const runs = (this.seen.get(p.key) ?? 0) + 1;
      this.seen.set(p.key, runs);
      return runs >= RUNS_BEFORE_TELLING && !this.told.has(p.key);
    });
    if (!fresh.length) return [];
    fresh.forEach((p) => this.told.add(p.key));
    this.tell(fresh);
    return fresh;
  }

  private tell(problems: HealthProblem[]) {
    const line = (p: HealthProblem) =>
      `${p.service}: ${p.title}${p.detail ? ` (${p.detail})` : ''}`;
    const [first] = problems;
    const more = problems.length - NAMED;
    try {
      notificationManager.sendNotification(Notification.HEALTH, {
        ...healthEvent(),
        notifyAdmin: true,
        notifySystem: true,
        subject:
          problems.length === 1
            ? `${first.service}: ${first.title}`
            : `${problems.length} new problems`,
        message:
          problems.length === 1
            ? (first.detail ?? 'See the Health page.')
            : [
                ...problems.slice(0, NAMED).map(line),
                ...(more > 0 ? [`and ${more} more`] : []),
              ].join('\n'),
        actionUrl: '/settings/health',
        actionUrlTitle: 'Open Health',
      });
    } catch (e) {
      logger.warn('Could not send a health alert', {
        label: 'Health',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Forgets everything, for tests. */
  public reset() {
    this.seen.clear();
    this.told.clear();
  }
}

const healthAlerts = new HealthAlerts();
export default healthAlerts;
