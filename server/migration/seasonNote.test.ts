import dataSource from '@server/datasource';
import { AddSeasonNote1795300000000 as PostgresMigration } from '@server/migration/postgres/1795300000000-AddSeasonNote';
import { AddSeasonNote1795300000000 as SqliteMigration } from '@server/migration/sqlite/1795300000000-AddSeasonNote';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The column that keeps each person's answer to a seasonal theme's note,
 * added by the migration for whichever database the tests run on
 * (DB_TYPE=postgres for Postgres).
 */

setupTestDb();

const columnsOf = async () => {
  const runner = dataSource.createQueryRunner();
  try {
    const table = await runner.getTable('user_settings');
    return new Map(table?.columns.map((column) => [column.name, column]));
  } finally {
    await runner.release();
  }
};

describe('the season note migration', () => {
  it('adds the column the entity expects, and takes it away again', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal((await columnsOf()).has('seasonNote'), false);

      await migration.up(runner);
      const column = (await columnsOf()).get('seasonNote');
      assert.equal(column?.type, 'text');
      assert.equal(column?.isNullable, true);
    } finally {
      await runner.release();
    }

    // Nothing about it left for the schema to change: the migration and the
    // entity agree.
    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /seasonNote/.test(query)),
      []
    );
  });
});
