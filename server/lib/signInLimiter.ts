import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';

/*
 * How many wrong passwords or password reset emails before a wait. Counted per
 * account and address together, so a guesser is slowed on the account they
 * target while its owner, signing in elsewhere, is not. Limiters made with
 * capAccount also cap one account's failures from every address together,
 * well above what one address may try. In memory: a restart drops the counts,
 * which only ever lets someone in sooner.
 */

const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 10;
const ACCOUNT_LIMIT = 50;
/** Most entries kept; past this the oldest are dropped. */
const MAX_ENTRIES = 100_000;

interface Attempts {
  count: number;
  resetAt: number;
}

/*
 * Kept in the order their windows end: an entry starting a new window is
 * always added at the end (see add), so pruning stops at the first live one.
 */
const attempts = new Map<string, Attempts>();

const prune = (now: number) => {
  for (const [key, entry] of attempts) {
    if (entry.resetAt > now && attempts.size < MAX_ENTRIES) {
      return;
    }
    attempts.delete(key);
  }
};

const add = (key: string, now: number) => {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.delete(key);
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count += 1;
  }
};

const remove = (key: string, now: number) => {
  const entry = attempts.get(key);
  if (!entry) {
    return;
  }
  if (entry.resetAt <= now || entry.count <= 1) {
    attempts.delete(key);
  } else {
    entry.count -= 1;
  }
};

const waitFor = (key: string, limit: number, now: number) => {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now || entry.count < limit) {
    return 0;
  }
  return Math.ceil((entry.resetAt - now) / 1000);
};

/**
 * The account is hashed: it is arbitrary unauthenticated input, and a key as
 * long as the body allows, kept for the whole window, would let anyone fill
 * memory.
 */
const accountKeyFor = (kind: string, account: unknown) =>
  `${kind}:${createHash('sha256')
    .update(String(account).trim().toLowerCase())
    .digest('base64url')}`;

const addressKeyFor = (accountKey: string, req: Request) =>
  `${accountKey}:${req.ip ?? ''}`;

export class SignInLimiter {
  private readonly capAccount: boolean;

  constructor(
    private readonly kind: string,
    options: { capAccount?: boolean } = {}
  ) {
    this.capAccount = options.capAccount ?? false;
  }

  /**
   * Whether this account may be tried now. If so, counts the attempt at once,
   * before it is checked; if not, sends 429 with the seconds to wait, and the
   * caller stops. After the attempt, call clear() if it succeeded or refund()
   * if it was no failure.
   */
  public take(req: Request, res: Response, account: unknown): boolean {
    const wait = this.reserve(req, account);
    if (!wait) {
      return true;
    }
    res.set('Retry-After', String(wait));
    res.status(429).json({
      message: 'Too many attempts. Try again in a few minutes.',
    });
    return false;
  }

  /** As take(), for callers that respond their own way: the wait, or 0. */
  public reserve(req: Request, account: unknown): number {
    const wait = this.retryAfter(req, account);
    if (!wait) {
      this.count(req, account);
    }
    return wait;
  }

  /**
   * Seconds until this account may be tried again from this address; 0 if now.
   * For callers that respond their own way and count only once the attempt is
   * checked, with nothing awaited in between.
   */
  public retryAfter(req: Request, account: unknown): number {
    const now = Date.now();
    const accountKey = accountKeyFor(this.kind, account);
    return Math.max(
      waitFor(addressKeyFor(accountKey, req), LIMIT, now),
      this.capAccount ? waitFor(accountKey, ACCOUNT_LIMIT, now) : 0
    );
  }

  /** Counts a wrong password, a sent reset email, or a failed sign-in. */
  public count(req: Request, account: unknown): void {
    const now = Date.now();
    prune(now);
    const accountKey = accountKeyFor(this.kind, account);
    add(addressKeyFor(accountKey, req), now);
    if (this.capAccount) {
      add(accountKey, now);
    }
  }

  /** Takes back an attempt counted by take() that turned out no failure. */
  public refund(req: Request, account: unknown): void {
    const now = Date.now();
    const accountKey = accountKeyFor(this.kind, account);
    remove(addressKeyFor(accountKey, req), now);
    if (this.capAccount) {
      remove(accountKey, now);
    }
  }

  /**
   * After a successful sign-in: clears this address's count for the account,
   * and takes the attempt, counted by take(), back from the account's.
   */
  public clear(req: Request, account: unknown): void {
    const accountKey = accountKeyFor(this.kind, account);
    attempts.delete(addressKeyFor(accountKey, req));
    if (this.capAccount) {
      remove(accountKey, Date.now());
    }
  }
}
