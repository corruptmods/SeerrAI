import dataSource, { getRepository } from '@server/datasource';
import LibraryAccessChange from '@server/entity/LibraryAccessChange';
import { AddLibraryAccessChanges1797000000000 as PostgresMigration } from '@server/migration/postgres/1797000000000-AddLibraryAccessChanges';
import { AddLibraryAccessChanges1797000000000 as SqliteMigration } from '@server/migration/sqlite/1797000000000-AddLibraryAccessChanges';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The history of library access changes, made by the migration for
 * whichever database the tests run on, and nothing left for the schema to
 * change after it.
 */

setupTestDb();

describe('the library access migration', () => {
  it('makes the table, and takes it away again', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal(await runner.hasTable('library_access_change'), false);
      await migration.up(runner);
      assert.equal(await runner.hasTable('library_access_change'), true);
    } finally {
      await runner.release();
    }

    const saved = await getRepository(LibraryAccessChange).save(
      new LibraryAccessChange({
        serverKind: 'jellyfin',
        action: 'remove',
        libraryId: 'a1',
        libraryTitle: 'Music',
        userId: 1,
        entries: [
          {
            id: 'u1',
            name: 'Viewer',
            before: { all: true, libraries: ['a1', 'b2'] },
            after: { all: false, libraries: ['b2'] },
          },
        ],
      })
    );
    const read = await getRepository(LibraryAccessChange).findOneByOrFail({
      id: saved.id,
    });
    assert.deepEqual(read.entries[0].after, { all: false, libraries: ['b2'] });
    assert.equal(read.undoneAt, null);

    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /library_access/.test(query)),
      []
    );
  });
});
