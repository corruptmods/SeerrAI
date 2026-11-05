/*
 * The single queue for all MusicBrainz requests. MusicBrainz allows about
 * one request per second per IP and returns 503 beyond that, so requests run
 * one at a time, spaced apart, with interactive ones ahead of background
 * work (scans, cache filling). Duplicate requests while queued run once.
 *
 * Interactive callers facing more than a few seconds' wait get a busy error
 * instead of a spinner; background work just waits. Requests nobody wants
 * any more (a superseded search) are dropped before starting.
 */

/** Interactive (a user on a page) or background (a scan). */
export type MbPriority = 'interactive' | 'background';

/** Thrown for a request dropped before starting because nobody wants it. */
export class MusicBrainzUnwantedError extends Error {
  constructor() {
    super('No longer wanted.');
    this.name = 'MusicBrainzUnwantedError';
  }
}

/** Checked just before a request starts; false drops it. */
export type StillWanted = () => boolean;

/** Thrown immediately when an interactive caller would wait too long. */
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
  /** Wanted checks; dropped once none passes. Undefined means always wanted. */
  wanted?: StillWanted[];
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export interface QueueOptions {
  /** Spacing between request starts, in ms. */
  spacingMs: () => number;
  /** Max interactive wait before a busy error. */
  maxWaitMs: number;
  /** Cap on a 503's Retry-After, in ms. */
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

/** Queue stats over the last hour, for Health. */
export interface QueueHealth {
  /** Requests queued or running. */
  waiting: number;
  /** Interactive requests refused as busy. */
  busy: number;
  /** 503 rate-limit responses. */
  rateLimited: number;
  /** Requests that finally failed (no answer, timeout, error). */
  failed: number;
  /** Consecutive failures since the last success. */
  failingInARow: number;
  lastError?: string;
  lastSuccessAt?: number;
}

const HEALTH_WINDOW_MS = 60 * 60 * 1000;

type Trouble = 'busy' | 'rateLimited' | 'failed';

export class RequestQueue {
  /** Timestamps of each trouble kind within the health window. */
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
  /** Queued or running jobs by key, so duplicates share one. */
  private jobs = new Map<string, Job>();
  private pumping = false;
  /** Earliest start time for the next request. */
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

  /** Queue health over the last hour. */
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

  /** Drops queued jobs nobody wants any more. */
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

  /** Expected wait for an interactive request added now. */
  public expectedWait(): number {
    return (
      Math.max(0, this.nextStart - this.now()) +
      this.waiting.interactive.length * this.options.spacingMs()
    );
  }

  /** Requests queued or running. */
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
      // Add the caller's check; without one, it's always wanted.
      existing.wanted =
        existing.wanted && wanted ? [...existing.wanted, wanted] : undefined;
      // An interactive caller promotes a queued background job.
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

    // Prune first so unwanted jobs don't count toward the wait.
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
          // Pick after the wait, so an interactive job that arrived meanwhile
          // goes first.
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
            // Rate limited: everyone backs off, then this job retries once,
            // first in its queue.
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
            // A 404 is a valid answer (not found). Anything else (another
            // 503, timeout, no response) counts as a failure.
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
