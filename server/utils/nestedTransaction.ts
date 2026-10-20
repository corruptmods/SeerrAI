import logger from '@server/logger';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

/*
 * A transaction opened inside another is a savepoint, and savepoints on one
 * connection can only be taken one after another: TypeORM names each after
 * a depth counter that it reads and bumps across an await, so two opened
 * side by side got the same name and undid each other. On Postgres that
 * aborted the whole outer transaction and handed its connection back to the
 * pool still aborted, failing whatever used it next. Saving several rows in
 * one call is enough to cause it, as their save hooks run at once.
 *
 * So nested transactions on one connection take turns. Turns are kept per
 * level: one waits only for its siblings, the others opened within the same
 * transaction it is. One opened inside it belongs to it and goes ahead
 * without waiting for it (it could never finish otherwise), taking turns
 * with its own siblings in the same way. Which nested transaction a call is
 * inside is followed with AsyncLocalStorage, which carries across awaits
 * and into TypeORM's save hooks; those are handed the outer transaction's
 * manager, so the manager alone can't say. A level is closed only once
 * everything started inside it has finished, so a savepoint is never
 * released or rolled back under work still running in it.
 *
 * SQLite takes its turns the same way, but without the savepoint: its one
 * connection is shared by the whole process, so any other transaction can
 * move the same counter, see https://github.com/typeorm/typeorm/issues/10209
 * and the revert in https://github.com/typeorm/typeorm/issues/11260. There a
 * failed nested transaction's own work is not undone, as before.
 */

interface Level {
  runner: QueryRunner;
  /** Settles when the last one queued at this level is done. */
  tail: Promise<void>;
  open: boolean;
  parent?: Level;
}

const current = new AsyncLocalStorage<Level>();
const topLevels = new WeakMap<QueryRunner, Level>();

// The innermost open level on this connection the caller is in, else the
// connection's own top level.
const levelFor = (runner: QueryRunner): Level => {
  for (let level = current.getStore(); level; level = level.parent) {
    if (level.runner === runner && level.open) {
      return level;
    }
  }
  let top = topLevels.get(runner);
  if (!top) {
    top = { runner, tail: Promise.resolve(), open: true };
    topLevels.set(runner, top);
  }
  return top;
};

// Waits for everything queued at this level, including what is queued while
// waiting, then closes it.
const close = async (level: Level): Promise<void> => {
  let tail: Promise<void>;
  do {
    tail = level.tail;
    await tail;
  } while (tail !== level.tail);
  level.open = false;
};

export const withNestedTransaction = <T>(
  manager: EntityManager,
  run: (manager: EntityManager) => Promise<T>
): Promise<T> => {
  const sqlite = manager.connection.options.type === 'sqlite';
  const runner = manager.queryRunner;

  // Not bound to a connection: on Postgres this is a transaction of its own
  // on a connection of its own, with nothing to share it with.
  if (!runner) {
    return sqlite ? run(manager) : manager.transaction(run);
  }

  const parent = levelFor(runner);
  const caller = current.getStore();

  const turn = parent.tail.then(() => {
    const level: Level = {
      runner,
      tail: Promise.resolve(),
      open: true,
      parent: caller,
    };
    const inLevel = (nested: EntityManager) =>
      current.run(level, async () => {
        try {
          return await run(nested);
        } finally {
          await close(level);
        }
      });
    return sqlite ? inLevel(manager) : manager.transaction(inLevel);
  });
  parent.tail = turn.then(
    () => undefined,
    () => undefined
  );
  return turn;
};

// The parts of pg's pool and client used below.
interface PooledClient {
  /** 'I' idle, 'T' in a transaction, 'E' in a failed one. */
  getTransactionStatus?: () => string | null;
  query: (text: string) => Promise<unknown>;
}
interface Pool {
  on(
    event: 'release',
    listener: (error: Error | undefined, client: PooledClient) => void
  ): void;
}
const guardedPools = new WeakSet<Pool>();

/**
 * Makes sure no Postgres connection goes back into the pool in the middle of
 * a transaction. One that does still holds its locks while it sits idle, and
 * if its transaction failed, the next user of the connection fails with
 * "current transaction is aborted". Such a connection is rolled back before
 * anyone else can use it: the rollback is queued on it at once, ahead of
 * anything the next user sends.
 */
export const rollBackOnRelease = (source: DataSource): void => {
  if (source.options.type !== 'postgres') {
    return;
  }
  const pool = (source.driver as unknown as { master?: Pool }).master;
  if (!pool || guardedPools.has(pool)) {
    return;
  }
  guardedPools.add(pool);
  pool.on('release', (error, client) => {
    // A connection handed back with an error is closed, not reused.
    const status = client.getTransactionStatus?.();
    if (error || (status !== 'T' && status !== 'E')) {
      return;
    }
    logger.error(
      'A database connection was handed back in the middle of a transaction; rolling it back',
      { label: 'Database', failed: status === 'E' }
    );
    client.query('ROLLBACK').catch((e: unknown) => {
      logger.error('Could not roll back a database connection', {
        label: 'Database',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    });
  });
};
