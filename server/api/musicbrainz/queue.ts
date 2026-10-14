/*
 * The one line every MusicBrainz request waits in. MusicBrainz allows about
 * one request a second from an address and answers 503 past that, so the
 * whole server shares this queue: one request at a time, spaced apart, with
 * people waiting on a page served before background work (scans, filling
 * the cache). The same request asked for twice while it waits is made once.
 *
 * Someone who would wait more than a few seconds is told MusicBrainz is busy
 * instead of being left looking at a spinner; background work just waits.
 */

/** Who is waiting: a person on a page, or a scan. */
export type MbPriority = 'interactive' | 'background';

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

export class RequestQueue {
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

  private sleep(ms: number): Promise<void> {
    return this.options.sleep
      ? this.options.sleep(ms)
      : new Promise((resolve) => setTimeout(resolve, ms));
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
    run: () => Promise<T>
  ): Promise<T> {
    const existing = this.jobs.get(key);
    if (existing) {
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

    if (
      priority === 'interactive' &&
      this.expectedWait() > this.options.maxWaitMs
    ) {
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
        const job = this.next();
        if (!job) {
          break;
        }
        this.nextStart = this.now() + this.options.spacingMs();
        try {
          job.resolve(await job.run());
          this.jobs.delete(job.key);
        } catch (e) {
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
