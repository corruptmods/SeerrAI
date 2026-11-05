import type { JobWatch } from '@server/api/bazarr';
import type {
  BazarrJobLive,
  SubtitleError,
  TranscriptionStatus,
} from '@server/interfaces/api/subtitlesInterfaces';
import logger from '@server/logger';

/*
 * Transcriptions run one at a time in request order: Whisper uses the whole
 * machine it runs on, so each is followed in Bazarr until done before the next
 * is requested. Requesting an episode already queued or running is a no-op.
 *
 * The queue is in memory. A restart drops what hadn't started; what was
 * running finishes in Bazarr regardless.
 */

/**
 * A failure the title page can explain: the reason as a code, and the message
 * as the same reason in English for the log.
 */
export class SubtitleProblem extends Error {
  constructor(
    public readonly problem: SubtitleError,
    message: string
  ) {
    super(message);
  }
}

export interface TranscriptionTask {
  /** One per movie or episode: requesting twice is requesting once. */
  key: string;
  /** The owning title ("movie:603", "tv:1399"), for its status. */
  owner: string;
  seasonNumber?: number;
  episodeNumber?: number;
  /** Queued because a search found nothing, not requested. */
  auto?: boolean;
  /** Notified when Bazarr queues it and when it starts. */
  run: (watch: JobWatch) => Promise<void>;
}

interface Tally {
  done: number;
  failed: number;
  /**
   * Why the last failure failed. Anyone who can see the title reads it, so
   * anything but a known reason is just "Bazarr failed"; details are logged.
   */
  error?: SubtitleError;
}

export class Transcriber {
  private queue: TranscriptionTask[] = [];
  private current?: TranscriptionTask;
  /** The running job is waiting in Bazarr's own queue. */
  private waiting = false;
  /** The running job's place in Bazarr's queue. */
  private live?: BazarrJobLive;
  /** Each title's search's place in Bazarr's queue. */
  private searchLive = new Map<string, BazarrJobLive>();
  private tallies = new Map<string, Tally>();
  /** Titles Bazarr is searching, with search counts. */
  private searches = new Map<string, number>();

  /** Adds tasks not already queued or running; returns how many. */
  public enqueue(tasks: TranscriptionTask[]): number {
    const known = new Set([
      ...this.queue.map((task) => task.key),
      ...(this.current ? [this.current.key] : []),
    ]);
    const added = tasks.filter((task) => {
      if (known.has(task.key)) {
        return false;
      }
      known.add(task.key);
      return true;
    });
    for (const task of added) {
      // A title requested again after its last batch finished starts a new
      // count.
      if (!this.isBusy(task.owner)) {
        this.tallies.set(task.owner, { done: 0, failed: 0 });
      }
      this.queue.push(task);
    }
    void this.pump();
    return added.length;
  }

  /**
   * Bazarr's own search for a title's missing subtitles, which can run for many
   * minutes; the title's status shows it searching meanwhile.
   */
  public async searching<T>(
    owner: string,
    work: (watch: JobWatch) => Promise<T>
  ): Promise<T> {
    this.searches.set(owner, (this.searches.get(owner) ?? 0) + 1);
    try {
      return await work({
        onUpdate: (live) => {
          if (this.searches.has(owner)) this.searchLive.set(owner, live);
        },
      });
    } finally {
      const left = (this.searches.get(owner) ?? 1) - 1;
      if (left > 0) {
        this.searches.set(owner, left);
      } else {
        this.searches.delete(owner);
        this.searchLive.delete(owner);
      }
    }
  }

  public isQueued(key: string): boolean {
    return (
      this.current?.key === key || this.queue.some((task) => task.key === key)
    );
  }

  private isBusy(owner: string): boolean {
    return (
      this.current?.owner === owner ||
      this.queue.some((task) => task.owner === owner)
    );
  }

  public status(owner: string): TranscriptionStatus {
    const tally = this.tallies.get(owner) ?? { done: 0, failed: 0 };
    const running = this.current?.owner === owner;
    const mine = [
      ...(running && this.current ? [this.current] : []),
      ...this.queue.filter((task) => task.owner === owner),
    ];
    return {
      queued: mine.length - (running ? 1 : 0),
      running,
      done: tally.done,
      failed: tally.failed,
      searching: this.searches.has(owner),
      auto: mine.filter((task) => task.auto).length,
      ...(running && this.waiting ? { waitingInBazarr: true } : {}),
      ...(this.searchLive.has(owner)
        ? { searchJob: this.searchLive.get(owner) }
        : {}),
      ...(running && this.live ? { transcribeJob: this.live } : {}),
      ...(tally.error ? { error: tally.error } : {}),
      ...(running &&
      this.current?.seasonNumber !== undefined &&
      this.current?.episodeNumber !== undefined
        ? {
            current: {
              seasonNumber: this.current.seasonNumber,
              episodeNumber: this.current.episodeNumber,
            },
          }
        : {}),
    };
  }

  private async pump(): Promise<void> {
    if (this.current) {
      return;
    }
    const task = this.queue.shift();
    if (!task) {
      return;
    }
    this.current = task;
    this.waiting = false;
    this.live = undefined;
    const tally = this.tallies.get(task.owner) ?? { done: 0, failed: 0 };
    try {
      await task.run({
        onWaiting: () => {
          if (this.current === task) this.waiting = true;
        },
        onRunning: () => {
          if (this.current === task) this.waiting = false;
        },
        onUpdate: (live) => {
          if (this.current === task) this.live = live;
        },
      });
      tally.done++;
    } catch (e) {
      tally.failed++;
      tally.error =
        e instanceof SubtitleProblem ? e.problem : { code: 'bazarrFailed' };
      logger.warn('A transcription did not finish', {
        label: 'Subtitles',
        task: task.key,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.tallies.set(task.owner, tally);
      this.current = undefined;
      this.waiting = false;
      this.live = undefined;
      void this.pump();
    }
  }
}

const transcriber = new Transcriber();

export default transcriber;
