import type { Session } from '@server/entity/Session';
import { sessionTtlSeconds } from '@server/lib/signIn';
import logger from '@server/logger';
import { TypeormStore } from 'connect-typeorm/out';
import type { SessionData, Store } from 'express-session';
import type { Repository } from 'typeorm';

/**
 * Longest a session's stored expiry may go without renewing: a tenth of its
 * lifetime, at most five minutes. Renewing it on every request was a database
 * write per API call.
 */
export const renewEvery = (ttlSeconds: number): number =>
  Math.min(5 * 60, Math.floor(ttlSeconds / 10)) * 1000;

/**
 * What is stored: the lifetime plus the renewal gap, so a session used just
 * after a skipped renewal still lasts its full lifetime from that use.
 */
const storedTtlSeconds = (session: { userId?: number }): number => {
  const ttl = sessionTtlSeconds(session);
  return ttl + renewEvery(ttl) / 1000;
};

/** Sessions remembered at once; the oldest are forgotten (and renewed). */
const MAX_REMEMBERED = 10_000;

/** Session store backed by the database via TypeORM. */
export const sessionStoreFor = (repository: Repository<Session>): Store => {
  const store = new TypeormStore({
    cleanupLimit: 2,
    // Signed-out sessions only hold a passkey challenge: they need minutes, not
    // a month, and anyone can create them.
    ttl: (_store, session) => storedTtlSeconds(session),
    // Without this, one failed query (Postgres briefly out of connections)
    // marks the store gone for good and nobody can sign in until restart. The
    // failed request still fails; the next retries the database.
    onError: (_store, error) =>
      logger.error('Session store query failed', {
        label: 'Server',
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
  }).connect(repository);

  // When each session's expiry was last written, and for which lifetime. A
  // session missing here is simply renewed.
  const written = new Map<string, { at: number; ttl: number }>();
  const remember = (sid: string, entry: { at: number; ttl: number }) => {
    written.delete(sid);
    if (written.size >= MAX_REMEMBERED) {
      written.delete(written.keys().next().value as string);
    }
    written.set(sid, entry);
  };
  const forget = (sid: string, entry?: { at: number; ttl: number }) => {
    if (!entry || written.get(sid) === entry) {
      written.delete(sid);
    }
  };

  const touch = store.touch;
  store.touch = (sid, session, callback) => {
    const ttl = sessionTtlSeconds(session);
    const last = written.get(sid);
    const now = Date.now();
    if (last && last.ttl === ttl && now - last.at < renewEvery(ttl)) {
      callback?.();
      return;
    }
    // Remembered before the write finishes, so a burst of requests writes once.
    const entry = { at: now, ttl };
    remember(sid, entry);
    touch(sid, session, (error?: unknown) => {
      if (error) {
        forget(sid, entry);
      }
      callback?.(error);
    });
  };

  const set = store.set;
  store.set = (sid: string, session: SessionData, callback) => {
    const entry = { at: Date.now(), ttl: sessionTtlSeconds(session) };
    set(sid, session, (error?: unknown) => {
      if (error) {
        forget(sid);
      } else {
        remember(sid, entry);
      }
      callback?.(error);
    });
  };

  const destroy = store.destroy;
  store.destroy = (sid: string | string[], callback) => {
    for (const id of Array.isArray(sid) ? sid : [sid]) {
      forget(id);
    }
    destroy(sid, callback);
  };

  return store as Store;
};
