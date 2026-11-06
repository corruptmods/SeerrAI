import dataSource from '@server/datasource';
import { AddUsedActionToken1798000000000 as PostgresMigration } from '@server/migration/postgres/1798000000000-AddUsedActionToken';
import { AddUsedActionToken1798000000000 as SqliteMigration } from '@server/migration/sqlite/1798000000000-AddUsedActionToken';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The table of notification buttons' used one-time tokens, added by the
 * migration for whichever database the tests run on (DB_TYPE=postgres for
 * Postgres).
 */

setupTestDb();

const tableExists = async () => {
  const runner = dataSource.createQueryRunner();
  try {
    return await runner.hasTable('used_action_token');
  } finally {
    await runner.release();
  }
};

describe('the used button tokens migration', () => {
  it('adds the table the entity expects, and takes it away again', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal(await tableExists(), false);
      await migration.up(runner);
      assert.equal(await tableExists(), true);
    } finally {
      await runner.release();
    }

    // Nothing about it left for the schema to change: the migration and the
    // entity agree.
    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /used_action_token/.test(query)),
      []
    );
  });
});
