import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';

/*
 * How many times someone may get a password wrong, or ask for a password
 * reset email, before being asked to wait. Counted per account and address
 * together: a guesser is slowed down on the account they are guessing,
 * while the account's owner, signing in from somewhere else, is not held up
 * by them. Kept in memory: a restart forgets the counts, which only ever
 * lets someone in sooner.
 */

const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 10;
/** Past this many entries, expired ones are cleared out on the next count. */
const PRUNE_AT = 1000;

interface Attempts {
  count: number;
  resetAt: number;
}

const attempts = new Map<string, Attempts>();

const prune = (now: number) => {
  if (attempts.size < PRUNE_AT) {
    return;
  }
  for (const [key, entry] of attempts) {
    if (entry.resetAt <= now) {
      attempts.delete(key);
    }
  }
};

/**
 * The account goes in as a hash: it is whatever was typed, from people not
 * signed in, and a key as long as the body allows, kept for the whole
 * window, would let anyone fill the memory.
 */
const keyFor = (kind: string, req: Request, account: unknown) =>
  `${kind}:${createHash('sha256')
    .update(String(account).trim().toLowerCase())
    .digest('base64url')}:${req.ip ?? ''}`;

export class SignInLimiter {
  constructor(private readonly kind: string) {}

  /**
   * Whether this account may be tried again from this address. When not,
   * the answer is sent (429, with how many seconds to wait) and the caller
   * stops there.
   */
  public allow(req: Request, res: Response, account: unknown): boolean {
    const wait = this.retryAfter(req, account);
    if (!wait) {
      return true;
    }
    res.set('Retry-After', String(wait));
    res.status(429).json({
      message: 'Too many attempts. Try again in a few minutes.',
    });
    return false;
  }

  /**
   * How many seconds until this account may be tried again from this
   * address; 0 when it may be now. For callers that answer in their own way.
   */
  public retryAfter(req: Request, account: unknown): number {
    const now = Date.now();
    const entry = attempts.get(keyFor(this.kind, req, account));
    if (!entry || entry.resetAt <= now || entry.count < LIMIT) {
      return 0;
    }
    return Math.ceil((entry.resetAt - now) / 1000);
  }

  /** Counts a wrong password, a reset email sent, or a failed sign-in. */
  public count(req: Request, account: unknown): void {
    const now = Date.now();
    prune(now);
    const key = keyFor(this.kind, req, account);
    const entry = attempts.get(key);
    if (!entry || entry.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    } else {
      entry.count += 1;
    }
  }

  /** Signed in: whatever went wrong before is forgotten. */
  public clear(req: Request, account: unknown): void {
    attempts.delete(keyFor(this.kind, req, account));
  }
}
