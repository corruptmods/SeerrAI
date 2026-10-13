import type {
  SubtitleError,
  TranscriptionStatus,
} from '@server/interfaces/api/subtitlesInterfaces';
import logger from '@server/logger';

/*
 * Transcriptions run one at a time, in the order they were asked for:
 * Whisper uses the whole of whatever machine runs it, and Bazarr answers
 * each one only once it is finished. Asking for an episode already queued
 * or under way does nothing.
 *
 * The queue is in memory. A restart forgets what had not started yet; what
 * was under way finishes in Bazarr regardless.
 */

/**
 * A failure the title page can explain: the reason travels with it as a
 * code, and its message is the same reason in English, for the log.
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
  /** One per movie or episode: asking twice is asking once. */
  key: string;
  /** The title it belongs to ("movie:603", "tv:1399"), for its status. */
  owner: string;
  seasonNumber?: number;
  episodeNumber?: number;
  /** Queued because a search found nothing, rather than asked for. */
  auto?: boolean;
  run: () => Promise<void>;
}

interface Tally {
  done: number;
  failed: number;
  /**
   * Why the last one that failed did. Anyone who can see the title reads
   * it, so anything other than a known reason is only "Bazarr failed"; the
   * detail is in the log.
   */
  error?: SubtitleError;
}

export class Transcriber {
  private queue: TranscriptionTask[] = [];
  private current?: TranscriptionTask;
  private tallies = new Map<string, Tally>();
  /** Titles Bazarr is searching for, and how many searches each. */
  private searches = new Map<string, number>();

  /** Adds what is not already queued or under way; returns how many. */
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
      // A title asked again once its last batch is over starts a new count.
      if (!this.isBusy(task.owner)) {
        this.tallies.set(task.owner, { done: 0, failed: 0 });
      }
      this.queue.push(task);
    }
    void this.pump();
    return added.length;
  }

  /**
   * Bazarr's own search for what a title is missing, which can run for many
   * minutes: the title's status says it is searching meanwhile.
   */
  public async searching<T>(owner: string, work: () => Promise<T>): Promise<T> {
    this.searches.set(owner, (this.searches.get(owner) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const left = (this.searches.get(owner) ?? 1) - 1;
      if (left > 0) {
        this.searches.set(owner, left);
      } else {
        this.searches.delete(owner);
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
    const tally = this.tallies.get(task.owner) ?? { done: 0, failed: 0 };
    try {
      await task.run();
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
      void this.pump();
    }
  }
}

const transcriber = new Transcriber();

export default transcriber;
