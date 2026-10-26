import dataSource, { getRepository } from '@server/datasource';
import BackfillSeries from '@server/entity/BackfillSeries';
import { AddBackfillByHand1796700000000 as PostgresMigration } from '@server/migration/postgres/1796700000000-AddBackfillByHand';
import { AddBackfillByHand1796700000000 as SqliteMigration } from '@server/migration/sqlite/1796700000000-AddBackfillByHand';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The column that marks titles an admin chose to follow in Backfill, made
 * by the migration for whichever database the tests run on
 * (DB_TYPE=postgres for Postgres). Titles followed before it count as
 * found by a scan.
 */

setupTestDb();

describe('the Backfill by-hand migration', () => {
  it('adds the column, with the titles already there found by a scan', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal(await runner.hasColumn('backfill_series', 'byHand'), false);
      await runner.query(
        `INSERT INTO "backfill_series" ("kind", "serverId", "arrId", "title") VALUES ('album', 0, 70, 'Static Garden')`
      );

      await migration.up(runner);
      assert.equal(await runner.hasColumn('backfill_series', 'byHand'), true);
      const old = await getRepository(BackfillSeries).findOneByOrFail({
        arrId: 70,
      });
      assert.equal(old.byHand, false);
      await getRepository(BackfillSeries).update(old.id, { byHand: true });
      assert.equal(
        (await getRepository(BackfillSeries).findOneByOrFail({ id: old.id }))
          .byHand,
        true
      );
    } finally {
      await runner.release();
    }

    // Nothing left for the schema to change: the migration and the entity
    // agree.
    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /backfill_series/.test(query)),
      []
    );
  });
});
