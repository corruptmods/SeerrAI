import { isAxiosError } from 'axios';

/*
 * Indexers limit how much they may be asked: so many searches, or so many
 * downloads of a .torrent or .nzb, a day. Once the limit is reached they
 * (or Prowlarr, for its own limits) answer 429 "Too Many Requests", or 503
 * with a Retry-After. That is not a failure: nothing is wrong with the
 * release, and asking again before the limit resets only spends another
 * request and keeps the limit reached. So every call Backfill and the admin
 * agent make to an indexer or Prowlarr goes through here: a limit is
 * remembered for that indexer, and nobody asks it again until it has had
 * time to reset.
 */

/** Waits after each limit in a row, when the indexer does not say how long. */
const FIRST_WAIT_MS = 15 * 60_000;
const LONGEST_WAIT_MS = 6 * 60 * 60_000;

/** How long to wait after the `strikes`th limit in a row: 15 min, 30, 1 h… 6 h. */
export const backoffMs = (strikes: number): number =>
  Math.min(FIRST_WAIT_MS * 2 ** Math.max(0, strikes - 1), LONGEST_WAIT_MS);

/** An indexer as a release names it, or Prowlarr itself. */
export interface IndexerRef {
  id?: number | null;
  name: string;
}

/** What is asked of it: a search, or a release's .torrent or .nzb. */
export type IndexerUse = 'search' | 'download';

/**
 * The longest wait a Retry-After is taken at: limits reset daily. Longer
 * would keep an indexer, or every search through Prowlarr, waiting for
 * good on one wrong answer.
 */
const LONGEST_RETRY_AFTER_MS = 24 * 60 * 60_000;

/** The time a Retry-After header gives, in seconds or as an HTTP date. */
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
 * Whether an error is an indexer's limit being reached, and until when it
 * says to wait, if it says. Sonarr's and Radarr's own calls wrap what went
 * wrong as the cause, so that is looked into too.
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
    // A 503 is a limit only when it says when to come back; without that
    // it is the indexer (or a proxy in front of it) being down.
    if (status === 503 && until !== undefined) return { until };
    return null;
  }
  return limitOf((e as { cause?: unknown }).cause, now, depth + 1);
};

/** "Tabula Rasa has reached its download limit". */
export const limitMessage = (name: string, use: IndexerUse): string =>
  `${name} has reached its ${use} limit`;

/**
 * Asked of an indexer that has reached its limit and not yet reset.
 * `asked` is whether it was asked this time (and answered with its limit),
 * rather than left alone because it is still waiting.
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
  /** Limits in a row, for the next wait to be longer. */
  strikes: number;
}

class IndexerLimits {
  private waits = new Map<string, Wait>();

  /*
   * By name: a release found through Sonarr's or Radarr's own search
   * carries their number for the indexer, not Prowlarr's, but the same name.
   */
  private key(ref: IndexerRef): string {
    return ref.name.trim().toLowerCase();
  }

  /** The limit an indexer is waiting out, if it is still waiting. */
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
   * Records an indexer's limit: until the time it gave, or else a little
   * longer for each limit in a row. Answers what was recorded.
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
   * Takes back a wait remembered elsewhere (a job's, after Seerr restarted),
   * unless a later one is known already.
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

  /** The indexer answered: its next limit starts the waits afresh. */
  public clear(ref: IndexerRef): void {
    this.waits.delete(this.key(ref));
  }

  /**
   * Asks an indexer something, unless it is waiting out a limit; a limit
   * in the answer is recorded. Either way an IndexerLimitReached is thrown.
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

/** Every indexer's wait, shared by Backfill and the admin agent. */
export const indexerLimits = new IndexerLimits();

/**
 * A limit in words, with how long until it may be asked again: "Prowlarr
 * has reached its search limit; it can be asked again in about 20 minutes".
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

/** Prowlarr itself, for its searches across every indexer. */
export const PROWLARR: IndexerRef = { name: 'Prowlarr' };
