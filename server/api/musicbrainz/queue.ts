/*
 * The one line every MusicBrainz request waits in. MusicBrainz allows about
 * one request a second from an address and answers 503 past that, so the
 * whole server shares this queue: one request at a time, spaced apart, with
 * people waiting on a page served before background work (scans, filling
 * the cache). The same request asked for twice while it waits is made once.
 *
 * Someone who would wait more than a few seconds is told MusicBrainz is busy
 * instead of being left looking at a spinner; background work just waits.
 * A request no one wants any more (a search typed past) is dropped before
 * it starts, so it takes no place ahead of the one that is wanted.
 */

/** Who is waiting: a person on a page, or a scan. */
export type MbPriority = 'interactive' | 'background';

/** A request dropped before it started: no one wanted it any more. */
export class MusicBrainzUnwantedError extends Error {
  constructor() {
    super('No longer wanted.');
    this.name = 'MusicBrainzUnwantedError';
  }
}

/** Whether someone still wants a request; asked just before it starts. */
export type StillWanted = () => boolean;

/** Answered at once when a person would otherwise wait too long. */
export class MusicBrainzBusyError extends Error {
  public readonly status = 503;

  constructor() {
    super('MusicBrainz is busy right now. Try again in a moment.');
    this.name = 'MusicBrainzBusyError';
  }
}

interface Job {
  key: string;
  priority: MbPriority;
  run: () => Promise<unknown>;
  retried: boolean;
  /**
   * Whether anyone still wants it. Undefined: someone always does (a
   * page, a scan); otherwise it is dropped once none of these does.
   */
  wanted?: StillWanted[];
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export interface QueueOptions {
  /** How far apart requests start, in ms. */
  spacingMs: () => number;
  /** The longest a person is kept waiting before being told it is busy. */
  maxWaitMs: number;
  /** The longest a 503's Retry-After is honoured for, in ms. */
  maxRetryAfterMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const statusOf = (e: unknown): number | undefined =>
  (e as { response?: { status?: number } })?.response?.status;

/** Retry-After in ms, from seconds or an HTTP date; undefined if absent. */
const retryAfterOf = (e: unknown, now: number): number | undefined => {
  const header = (
    e as { response?: { headers?: Record<string, string | undefined> } }
  )?.response?.headers?.['retry-after'];
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds * 1000;
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
};

/** How the line has fared over the last hour, for Health. */
export interface QueueHealth {
  /** Requests waiting or under way now. */
  waiting: number;
  /** People told MusicBrainz was busy rather than kept waiting. */
  busy: number;
  /** Times MusicBrainz said it was over its limit (503). */
  rateLimited: number;
  /** Requests that failed in the end: no answer, a timeout, an error. */
  failed: number;
  /** Failures one after another since a request last worked. */
  failingInARow: number;
  lastError?: string;
  lastSuccessAt?: number;
}

/** How far back Health looks. */
const HEALTH_WINDOW_MS = 60 * 60 * 1000;

type Trouble = 'busy' | 'rateLimited' | 'failed';

export class RequestQueue {
  /** When each kind of trouble happened, over the last hour. */
  private seen: Record<Trouble, number[]> = {
    busy: [],
    rateLimited: [],
    failed: [],
  };
  private failingInARow = 0;
  private lastError?: string;
  private lastSuccessAt?: number;

  private waiting: Record<MbPriority, Job[]> = {
    interactive: [],
    background: [],
  };
  /** Waiting or under way, by key, so a repeat shares the first. */
  private jobs = new Map<string, Job>();
  private pumping = false;
  /** The earliest the next request may start. */
  private nextStart = 0;

  constructor(private options: QueueOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private note(kind: Trouble) {
    const now = this.now();
    const list = this.seen[kind].filter((at) => now - at < HEALTH_WINDOW_MS);
    list.push(now);
    this.seen[kind] = list;
  }

  /** How MusicBrainz has answered over the last hour. */
  public health(): QueueHealth {
    const now = this.now();
    const count = (kind: Trouble) =>
      this.seen[kind].filter((at) => now - at < HEALTH_WINDOW_MS).length;
    return {
      waiting: this.jobs.size,
      busy: count('busy'),
      rateLimited: count('rateLimited'),
      failed: count('failed'),
      failingInARow: this.failingInARow,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep
      ? this.options.sleep(ms)
      : new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Drops what is waiting that no one wants any more. */
  private prune() {
    for (const priority of ['interactive', 'background'] as const) {
      this.waiting[priority] = this.waiting[priority].filter((job) => {
        if (!job.wanted || job.wanted.some((wanted) => wanted())) {
          return true;
        }
        this.jobs.delete(job.key);
        job.reject(new MusicBrainzUnwantedError());
        return false;
      });
    }
  }

  /** How long a request from a person, added now, would wait to start. */
  public expectedWait(): number {
    return (
      Math.max(0, this.nextStart - this.now()) +
      this.waiting.interactive.length * this.options.spacingMs()
    );
  }

  /** Requests waiting or under way. */
  public get size(): number {
    return this.jobs.size;
  }

  public add<T>(
    key: string,
    priority: MbPriority,
    run: () => Promise<T>,
    wanted?: StillWanted
  ): Promise<T> {
    const existing = this.jobs.get(key);
    if (existing) {
      // Wanted by one more, or (with no test) by someone for good.
      existing.wanted =
        existing.wanted && wanted ? [...existing.wanted, wanted] : undefined;
      // A person now waits on what a scan asked for: it moves up.
      if (priority === 'interactive' && existing.priority === 'background') {
        const index = this.waiting.background.indexOf(existing);
        if (index >= 0) {
          this.waiting.background.splice(index, 1);
          existing.priority = 'interactive';
          this.waiting.interactive.push(existing);
        }
      }
      return existing.promise as Promise<T>;
    }

    // What no one wants any more is not counted in the wait.
    this.prune();
    if (
      priority === 'interactive' &&
      this.expectedWait() > this.options.maxWaitMs
    ) {
      this.note('busy');
      return Promise.reject(new MusicBrainzBusyError());
    }

    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job: Job = {
      key,
      priority,
      run,
      retried: false,
      ...(wanted ? { wanted: [wanted] } : {}),
      promise,
      resolve,
      reject,
    };
    this.jobs.set(key, job);
    this.waiting[priority].push(job);
    void this.pump();
    return promise as Promise<T>;
  }

  private next(): Job | undefined {
    return this.waiting.interactive.shift() ?? this.waiting.background.shift();
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (
        this.waiting.interactive.length ||
        this.waiting.background.length
      ) {
        const wait = this.nextStart - this.now();
        if (wait > 0) {
          // Chosen after the wait, so a person who arrived meanwhile goes
          // ahead of a scan.
          await this.sleep(wait);
          continue;
        }
        this.prune();
        const job = this.next();
        if (!job) {
          break;
        }
        this.nextStart = this.now() + this.options.spacingMs();
        try {
          job.resolve(await job.run());
          this.jobs.delete(job.key);
          this.failingInARow = 0;
          this.lastSuccessAt = this.now();
        } catch (e) {
          if (statusOf(e) === 503) {
            this.note('rateLimited');
          }
          if (statusOf(e) === 503 && !job.retried) {
            // Over the limit after all: everyone backs off, then this one
            // is tried once more, first in its line.
            job.retried = true;
            const backOff = Math.min(
              retryAfterOf(e, this.now()) ?? this.options.spacingMs() * 2,
              this.options.maxRetryAfterMs ?? 30_000
            );
            this.nextStart = Math.max(
              this.nextStart,
              this.now() + Math.max(backOff, this.options.spacingMs())
            );
            this.waiting[job.priority].unshift(job);
          } else {
            // A 404 is an answer: there is no such thing. Anything else
            // (another 503, a timeout, no answer at all) is MusicBrainz
            // failing.
            if (statusOf(e) === 404) {
              this.failingInARow = 0;
              this.lastSuccessAt = this.now();
            } else {
              this.note('failed');
              this.failingInARow++;
              this.lastError = statusOf(e)
                ? `MusicBrainz answered ${statusOf(e)}`
                : e instanceof Error
                  ? e.message
                  : String(e);
            }
            job.reject(e);
            this.jobs.delete(job.key);
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}
