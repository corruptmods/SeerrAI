import dataSource from '@server/datasource';
import { AddSidebarLayout1793800000000 as PostgresMigration } from '@server/migration/postgres/1793800000000-AddSidebarLayout';
import { AddSidebarLayout1793800000000 as SqliteMigration } from '@server/migration/sqlite/1793800000000-AddSidebarLayout';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The columns that keep each person's sidebar, added by the migration for
 * whichever database the tests run on (DB_TYPE=postgres for Postgres).
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

describe('the sidebar migration', () => {
  it('adds the columns the entity expects, and takes them away again', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      let columns = await columnsOf();
      assert.equal(columns.has('sidebarOrder'), false);
      assert.equal(columns.has('sidebarHidden'), false);

      await migration.up(runner);
      columns = await columnsOf();
      for (const name of ['sidebarOrder', 'sidebarHidden']) {
        assert.equal(columns.get(name)?.type, 'text', name);
        assert.equal(columns.get(name)?.isNullable, true, name);
      }
    } finally {
      await runner.release();
    }

    // Nothing about them left for the schema to change: the migration and
    // the entity agree.
    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /sidebar(Order|Hidden)/.test(query)),
      []
    );
  });
});
