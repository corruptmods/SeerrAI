import dataSource from '@server/datasource';
import { AddSilo1798700000000 as PostgresMigration } from '@server/migration/postgres/1798700000000-AddSilo';
import { AddSilo1798700000000 as SqliteMigration } from '@server/migration/sqlite/1798700000000-AddSilo';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Silo's columns and tables, added by the migration for whichever database the
 * tests run on (DB_TYPE=postgres for Postgres).
 */

setupTestDb();

const tableOf = async (name: string) => {
  const runner = dataSource.createQueryRunner();
  try {
    return await runner.getTable(name);
  } finally {
    await runner.release();
  }
};

const columnNames = async (name: string) =>
  new Set((await tableOf(name))?.columns.map((column) => column.name));

describe('the Silo migration', () => {
  it('goes down and up again, and agrees with the entities', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal(await tableOf('silo_episode'), undefined);
      assert.equal(await tableOf('silo_play'), undefined);
      const userColumns = await columnNames('user');
      assert.equal(userColumns.has('siloUserId'), false);
      assert.equal(userColumns.has('siloProfileId'), false);
      assert.equal((await columnNames('media')).has('siloMediaId'), false);

      await migration.up(runner);
    } finally {
      await runner.release();
    }

    const user = await columnNames('user');
    for (const column of ['siloUsername', 'siloUserId', 'siloProfileId']) {
      assert.ok(user.has(column), column);
    }
    const media = await columnNames('media');
    assert.ok(media.has('siloMediaId'));
    assert.ok(media.has('siloMediaId4k'));
    assert.ok((await columnNames('silo_episode')).has('seriesId'));
    assert.ok((await columnNames('silo_play')).has('sessionId'));

    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /silo/i.test(query)),
      []
    );
  });
});
