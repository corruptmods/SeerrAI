import { isAxiosError } from 'axios';

/*
 * Indexers cap daily searches and .torrent/.nzb downloads. Past the cap they
 * (or Prowlarr, for its own limits) answer 429, or 503 with Retry-After.
 * That isn't a release failure, and asking again before the reset only
 * spends another request. So every Backfill and admin agent call to an
 * indexer or Prowlarr goes through here: a limit is remembered per indexer,
 * and it isn't asked again until it has had time to reset.
 */

/** Backoff bounds for consecutive limits when the indexer gives no wait. */
const FIRST_WAIT_MS = 15 * 60_000;
const LONGEST_WAIT_MS = 6 * 60 * 60_000;

/** Wait after the `strikes`th consecutive limit: 15 min, 30, 1 h… 6 h. */
export const backoffMs = (strikes: number): number =>
  Math.min(FIRST_WAIT_MS * 2 ** Math.max(0, strikes - 1), LONGEST_WAIT_MS);

/** An indexer as a release names it, or Prowlarr itself. */
export interface IndexerRef {
  id?: number | null;
  name: string;
}

/** A search, or fetching a release's .torrent or .nzb. */
export type IndexerUse = 'search' | 'download';

/**
 * Cap on Retry-After, since limits reset daily. Longer would block an
 * indexer, or every Prowlarr search, indefinitely on one bad answer.
 */
const LONGEST_RETRY_AFTER_MS = 24 * 60 * 60_000;

/** The time a Retry-After header gives (seconds or HTTP date), capped. */
export const retryAfterOf = (
  header: unknown,
  now = Date.now()
): number | undefined => {
  const value = String(header ?? '').trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    return now + Math.min(Number(value) * 1000, LONGEST_RETRY_AFTER_MS);
  }
  const at = Date.parse(value);
  return Number.isNaN(at) || at <= now
    ? undefined
    : Math.min(at, now + LONGEST_RETRY_AFTER_MS);
};

/**
 * Whether an error is an indexer limit, with its Retry-After if given.
 * Searches wrapped causes, as Sonarr and Radarr API wrappers use them.
 */
export const limitOf = (
  e: unknown,
  now = Date.now(),
  depth = 0
): { until?: number } | null => {
  if (!e || typeof e !== 'object' || depth > 3) return null;
  if (isAxiosError(e) && e.response) {
    const { status, headers } = e.response;
    const header =
      typeof headers?.get === 'function'
        ? headers.get('retry-after')
        : headers?.['retry-after'];
    const until = retryAfterOf(header, now);
    if (status === 429) return { until };
    // A 503 without Retry-After is the indexer (or its proxy) being down.
    if (status === 503 && until !== undefined) return { until };
    return null;
  }
  return limitOf((e as { cause?: unknown }).cause, now, depth + 1);
};

/** "Tabula Rasa has reached its download limit". */
export const limitMessage = (name: string, use: IndexerUse): string =>
  `${name} has reached its ${use} limit`;

/**
 * An indexer is at its limit and not yet reset. `asked` is true if it was
 * asked this time and answered with the limit, false if skipped while
 * waiting.
 */
export class IndexerLimitReached extends Error {
  constructor(
    public readonly indexer: string,
    public readonly use: IndexerUse,
    public readonly until: Date,
    public readonly strikes: number,
    public readonly asked: boolean
  ) {
    super(limitMessage(indexer, use));
    this.name = 'IndexerLimitReached';
  }
}

interface Wait {
  name: string;
  use: IndexerUse;
  until: number;
  /** Consecutive limits, to lengthen the next wait. */
  strikes: number;
}

class IndexerLimits {
  private waits = new Map<string, Wait>();

  /*
   * Keyed by name: releases from Sonarr's or Radarr's search carry their
   * indexer id, not Prowlarr's, but the same name.
   */
  private key(ref: IndexerRef): string {
    return ref.name.trim().toLowerCase();
  }

  /** The limit an indexer is still waiting out, if any. */
  public waiting(
    ref: IndexerRef,
    now = Date.now()
  ): IndexerLimitReached | null {
    const wait = this.waits.get(this.key(ref));
    if (!wait || wait.until <= now) return null;
    return new IndexerLimitReached(
      wait.name,
      wait.use,
      new Date(wait.until),
      wait.strikes,
      false
    );
  }

  /**
   * Records a limit until the given time, else with growing backoff.
   * Returns what was recorded.
   */
  public hit(
    ref: IndexerRef,
    use: IndexerUse,
    until: number | undefined,
    now = Date.now()
  ): IndexerLimitReached {
    const before = this.waits.get(this.key(ref));
    const strikes = (before?.strikes ?? 0) + 1;
    const wait: Wait = {
      name: ref.name,
      use,
      until: until ?? now + backoffMs(strikes),
      strikes,
    };
    this.waits.set(this.key(ref), wait);
    return new IndexerLimitReached(
      wait.name,
      use,
      new Date(wait.until),
      strikes,
      true
    );
  }

  /**
   * Restores a wait saved elsewhere (a job's, after a restart) unless a
   * later one is known.
   */
  public restore(
    ref: IndexerRef,
    use: IndexerUse,
    until: number,
    strikes: number
  ): void {
    const known = this.waits.get(this.key(ref));
    if (known && known.until >= until) return;
    this.waits.set(this.key(ref), { name: ref.name, use, until, strikes });
  }

  /** The indexer answered: its next limit restarts the backoff. */
  public clear(ref: IndexerRef): void {
    this.waits.delete(this.key(ref));
  }

  /**
   * Calls the indexer unless it is waiting out a limit; a limit in the
   * answer is recorded. Either way throws IndexerLimitReached.
   */
  public async guard<T>(
    ref: IndexerRef,
    use: IndexerUse,
    ask: () => Promise<T>
  ): Promise<T> {
    const waiting = this.waiting(ref);
    if (waiting) throw waiting;
    try {
      const answer = await ask();
      this.clear(ref);
      return answer;
    } catch (e) {
      const limit = limitOf(e);
      if (limit) throw this.hit(ref, use, limit.until);
      throw e;
    }
  }

  /** Forgets every wait, for tests. */
  public reset(): void {
    this.waits.clear();
  }
}

/** Indexer waits shared by Backfill and the admin agent. */
export const indexerLimits = new IndexerLimits();

/**
 * A limit in words with time until reset: "Prowlarr has reached its search
 * limit; it can be asked again in about 20 minutes".
 */
export const limitHint = (
  limit: IndexerLimitReached,
  now = Date.now()
): string => {
  const minutes = Math.max(
    1,
    Math.ceil((limit.until.getTime() - now) / 60_000)
  );
  const hours = Math.round(minutes / 60);
  return `${limit.message}; it can be asked again in about ${
    minutes < 90 ? `${minutes} minutes` : `${hours} hours`
  }`;
};

/** Prowlarr itself, for its searches across all indexers. */
export const PROWLARR: IndexerRef = { name: 'Prowlarr' };
