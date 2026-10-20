import { MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MediaEvent, { MediaEventType } from '@server/entity/MediaEvent';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import { withNestedTransaction } from '@server/utils/nestedTransaction';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EntityManager, QueryRunner } from 'typeorm';

/*
 * Nested transactions opened side by side on one connection, called
 * directly rather than through any save hook. A nested transaction is a
 * savepoint, and TypeORM names a savepoint after a depth counter it reads
 * and bumps across an await: two opened at once got the same name, undid
 * each other and aborted the whole transaction on Postgres.
 */

setupTestDb();

// Two queries with an await between them, so work opened side by side
// really does interleave on the connection.
const write = async (manager: EntityManager, ...tmdbIds: number[]) => {
  for (const tmdbId of tmdbIds) {
    await manager.insert(MediaEvent, {
      tmdbId,
      mediaType: MediaType.MOVIE,
      type: MediaEventType.SEARCHED,
    });
  }
};

// A write the database refuses: the media type is required.
const refusedWrite = (manager: EntityManager) =>
  manager.insert(MediaEvent, {
    tmdbId: 999,
    mediaType: null as never,
    type: MediaEventType.SEARCHED,
  });

const written = async () =>
  (await getRepository(MediaEvent).find({ order: { tmdbId: 'ASC' } })).map(
    (event) => event.tmdbId
  );

// The transaction's connection is left exactly as it was found: no
// transaction open, no savepoint counted.
const assertClean = (runner: QueryRunner | undefined) => {
  assert.ok(runner);
  assert.equal(runner.isTransactionActive, false, 'no transaction left open');
  assert.equal(
    (runner as unknown as { transactionDepth: number }).transactionDepth,
    0,
    'no savepoint left counted'
  );
};

describe('nested transactions on one connection', () => {
  it('keeps the work of two opened side by side', async () => {
    let runner: QueryRunner | undefined;
    await dataSource.transaction(async (em) => {
      runner = em.queryRunner;
      await Promise.all([
        withNestedTransaction(em, (m) => write(m, 1, 2)),
        withNestedTransaction(em, (m) => write(m, 3, 4)),
      ]);
    });

    assert.deepEqual(await written(), [1, 2, 3, 4]);
    assertClean(runner);
  });

  it('keeps the work of many opened side by side, and the outer work', async () => {
    let runner: QueryRunner | undefined;
    await dataSource.transaction(async (em) => {
      runner = em.queryRunner;
      await write(em, 100);
      await Promise.all(
        [1, 2, 3, 4, 5, 6].map((n) =>
          withNestedTransaction(em, (m) => write(m, n * 10, n * 10 + 1))
        )
      );
      await write(em, 200);
    });

    assert.deepEqual(
      await written(),
      [10, 11, 20, 21, 30, 31, 40, 41, 50, 51, 60, 61, 100, 200]
    );
    assertClean(runner);
  });

  it(
    'runs one opened inside another straight away, through either manager',
    {
      timeout: 10000,
    },
    async () => {
      let runner: QueryRunner | undefined;
      await dataSource.transaction(async (em) => {
        runner = em.queryRunner;
        await Promise.all([
          withNestedTransaction(em, async (inner) => {
            await write(inner, 1);
            // Opened inside this one: through its own manager, and through the
            // outer one as a save hook does (it is handed the outer
            // transaction's manager). Neither may wait for the one it is in.
            await Promise.all([
              withNestedTransaction(inner, (m) => write(m, 2, 3)),
              withNestedTransaction(em, async (m) => {
                await write(m, 4);
                await withNestedTransaction(m, (deepest) => write(deepest, 5));
                await write(m, 6);
              }),
            ]);
            await write(inner, 7);
          }),
          withNestedTransaction(em, (m) => write(m, 8, 9)),
        ]);
      });

      assert.deepEqual(await written(), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      assertClean(runner);
    }
  );

  it('keeps the others and the outer transaction when one fails', async () => {
    let runner: QueryRunner | undefined;
    const outcomes = await dataSource.transaction(async (em) => {
      runner = em.queryRunner;
      const settled = await Promise.allSettled([
        withNestedTransaction(em, (m) => write(m, 1)),
        withNestedTransaction(em, async (m) => {
          await write(m, 2);
          throw new Error('given up');
        }),
        withNestedTransaction(em, async (m) => {
          await write(m, 3);
          await refusedWrite(m);
        }),
        withNestedTransaction(em, (m) => write(m, 4)),
      ]);
      // After a refused write the outer transaction still takes more work.
      await write(em, 5);
      return settled.map((outcome) => outcome.status);
    });

    assert.deepEqual(outcomes, [
      'fulfilled',
      'rejected',
      'rejected',
      'fulfilled',
    ]);
    // Postgres undoes a failed one's own work. SQLite has no savepoints here
    // (see nestedTransaction.ts), so there it stays, as it always has.
    assert.deepEqual(await written(), isPgsql ? [1, 4, 5] : [1, 2, 3, 4, 5]);
    assertClean(runner);
  });

  it('undoes a failed inner one without its parent', async () => {
    let runner: QueryRunner | undefined;
    await dataSource.transaction(async (em) => {
      runner = em.queryRunner;
      await withNestedTransaction(em, async (inner) => {
        await write(inner, 1);
        await Promise.allSettled([
          withNestedTransaction(inner, async (m) => {
            await write(m, 2);
            await refusedWrite(m);
          }),
          withNestedTransaction(inner, (m) => write(m, 3)),
        ]);
        await write(inner, 4);
      });
    });

    assert.deepEqual(await written(), isPgsql ? [1, 3, 4] : [1, 2, 3, 4]);
    assertClean(runner);
  });

  it('finishes work one started and left running before it ends', async () => {
    let runner: QueryRunner | undefined;
    await dataSource.transaction(async (em) => {
      runner = em.queryRunner;
      await withNestedTransaction(em, async (inner) => {
        await write(inner, 1);
        // Not awaited: it still belongs to this one, and has to be done
        // before this one's savepoint is released.
        void withNestedTransaction(inner, async (m) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await write(m, 2);
        });
      });
      await write(em, 3);
    });

    assert.deepEqual(await written(), [1, 2, 3]);
    assertClean(runner);
  });

  it('leaves the connection usable for the next transaction', async () => {
    await dataSource.transaction(async (em) => {
      await Promise.allSettled([
        withNestedTransaction(em, (m) => write(m, 1)),
        withNestedTransaction(em, (m) => refusedWrite(m)),
        withNestedTransaction(em, (m) => write(m, 2)),
      ]);
    });
    await dataSource.transaction((em) => write(em, 3));

    assert.deepEqual(await written(), [1, 2, 3]);
  });
});

describe('a connection handed back to the pool', () => {
  it(
    'is never reused in the middle of a transaction',
    {
      skip: !isPgsql && 'Postgres only: SQLite has one connection and no pool',
    },
    async () => {
      const runner = dataSource.createQueryRunner();
      const connection = await runner.connect();
      await runner.startTransaction();
      await assert.rejects(runner.query('SELECT 1/0'));
      // Handed back without a rollback, its transaction aborted.
      await runner.release();

      const next = dataSource.createQueryRunner();
      try {
        assert.equal(await next.connect(), connection, 'the same connection');
        assert.deepEqual(await next.query('SELECT 1 AS one'), [{ one: 1 }]);
      } finally {
        await next.release();
      }
    }
  );
});
