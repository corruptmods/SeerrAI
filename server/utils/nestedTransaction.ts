import logger from '@server/logger';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';

/*
 * A transaction inside another is a savepoint, and savepoints on one
 * connection must be taken one at a time: TypeORM names each after a depth
 * counter it reads and bumps across an await, so two opened concurrently got
 * the same name and undid each other. On Postgres that aborted the outer
 * transaction and returned its connection to the pool still aborted, failing
 * its next user. Saving several rows in one call triggers it, since their
 * save hooks run concurrently.
 *
 * So nested transactions on one connection take turns, per level: each waits
 * only for its siblings in the same transaction. One opened inside it belongs
 * to it and proceeds without waiting (it could never finish otherwise),
 * taking turns with its own siblings. The enclosing nested transaction is
 * tracked with AsyncLocalStorage, which carries across awaits and into
 * TypeORM's save hooks; those get the outer transaction's manager, so the
 * manager alone can't tell. A level closes only once everything started in
 * it has finished, so a savepoint is never released or rolled back under
 * running work.
 *
 * SQLite takes turns the same way but without savepoints: its one connection
 * is shared by the whole process, so any other transaction can move the same
 * counter, see https://github.com/typeorm/typeorm/issues/10209 and the revert
 * in https://github.com/typeorm/typeorm/issues/11260. There a failed nested
 * transaction's own work is not undone.
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

// The innermost open level on this connection that the caller is in, else the
// connection's top level.
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

// Waits for everything queued at this level, including work queued meanwhile,
// then closes it.
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

  // Not bound to a connection: on Postgres this is its own transaction on its
  // own connection, with nothing to share.
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
 * Ensures no Postgres connection returns to the pool mid-transaction. Such a
 * connection holds its locks while idle, and if its transaction failed, the
 * next user gets "current transaction is aborted". The rollback is queued on it
 * immediately, ahead of anything the next user sends.
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
    // A connection released with an error is closed, not reused.
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
