import dataSource, { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { AddUserPlaylistLink1798600000000 as PostgresMigration } from '@server/migration/postgres/1798600000000-AddUserPlaylistLink';
import { AddUserPlaylistLink1798600000000 as SqliteMigration } from '@server/migration/sqlite/1798600000000-AddUserPlaylistLink';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The column that says whether a user may import playlists, added by the
 * migration for whichever database the tests run on (DB_TYPE=postgres for
 * Postgres).
 */

setupTestDb();

const columnsOf = async () => {
  const runner = dataSource.createQueryRunner();
  try {
    const table = await runner.getTable('user');
    return new Map(table?.columns.map((column) => [column.name, column]));
  } finally {
    await runner.release();
  }
};

describe('the playlist importing migration', () => {
  it('lets everyone already here keep importing, and agrees with the entity', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal((await columnsOf()).has('playlistLink'), false);

      await migration.up(runner);
      const column = (await columnsOf()).get('playlistLink');
      assert.equal(column?.type, 'boolean');
      assert.equal(column?.isNullable, false);
    } finally {
      await runner.release();
    }

    const users = await getRepository(User).find();
    assert.ok(users.length > 0);
    assert.ok(users.every((user) => user.playlistLink === true));

    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /playlistLink/.test(query)),
      []
    );
  });
});
