import type { HealthCheck } from '@server/lib/health';
import { serviceChecks } from '@server/lib/health';
import notificationManager, { Notification } from '@server/lib/notifications';
import logger from '@server/logger';

/*
 * Tells admins when something on the Health page newly goes wrong with a
 * connected service, so a paused WhisperAI or an indexer Prowlarr gave up
 * on is heard about without opening the page.
 *
 * A problem is told once, when it has been seen on two runs in a row (a
 * moment's timeout is not worth a notification), and not again until it
 * has cleared. What has been told is kept in memory: after a restart, a
 * problem still there is told once more.
 */

/** Runs a problem must be seen on, in a row, before it is told. */
export const RUNS_BEFORE_TELLING = 2;
/** Problems named in one notification before "and N more". */
const NAMED = 5;

export interface HealthProblem {
  key: string;
  /** The service's name. */
  service: string;
  title: string;
  detail?: string;
}

/** Every problem the service checks found, one per thing wrong. */
export const problemsIn = (checks: HealthCheck[]): HealthProblem[] =>
  checks.flatMap((check) => {
    const service = check.name ?? check.id;
    if (check.status === 'ok') return [];
    // Down, or not answering: one problem, whatever it said.
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
  /** How many runs in a row each problem has been seen on. */
  private seen = new Map<string, number>();
  /** Problems told, until they clear. */
  private told = new Set<string>();
  private running = false;

  /** Checks once; tells admins what newly went wrong. */
  public async run(): Promise<HealthProblem[]> {
    if (this.running) return [];
    this.running = true;
    try {
      return this.consider(problemsIn(await serviceChecks()));
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

  /** What to tell, of what was found this run; sends it. */
  public consider(problems: HealthProblem[]): HealthProblem[] {
    const now = new Set(problems.map((p) => p.key));
    for (const key of [...this.seen.keys()]) {
      if (!now.has(key)) {
        // Cleared: told again if it comes back.
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
        event: 'Health',
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
