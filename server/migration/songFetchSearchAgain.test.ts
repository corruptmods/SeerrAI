import dataSource from '@server/datasource';
import { AddSongFetchSearchAgain1797200000000 as PostgresMigration } from '@server/migration/postgres/1797200000000-AddSongFetchSearchAgain';
import { AddSongFetchSearchAgain1797200000000 as SqliteMigration } from '@server/migration/sqlite/1797200000000-AddSongFetchSearchAgain';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * When an album's songs are looked for again: added by the migration for
 * whichever database the tests run on, and nothing left for the schema to
 * change after it.
 */

setupTestDb();

describe('the song fetch search-again migration', () => {
  it('adds the columns, and takes them away again', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal(await runner.hasColumn('song_fetch', 'searches'), false);
      await migration.up(runner);
      assert.equal(await runner.hasColumn('song_fetch', 'searches'), true);
      assert.equal(await runner.hasColumn('song_fetch', 'searchAgainAt'), true);
    } finally {
      await runner.release();
    }

    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /song_fetch/.test(query)),
      []
    );
  });
});
