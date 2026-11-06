import { MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { AddMediaQuality1797930000000 as PostgresMigration } from '@server/migration/postgres/1797930000000-AddMediaQuality';
import { AddMediaQuality1797930000000 as SqliteMigration } from '@server/migration/sqlite/1797930000000-AddMediaQuality';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The column of qualities scans saw on each title, added by the migration for
 * whichever database the tests run on (DB_TYPE=postgres for Postgres).
 */

setupTestDb();

const columnsOf = async () => {
  const runner = dataSource.createQueryRunner();
  try {
    const table = await runner.getTable('media');
    return new Map(table?.columns.map((column) => [column.name, column]));
  } finally {
    await runner.release();
  }
};

describe('the media quality migration', () => {
  it('adds an empty column that agrees with the entity', async () => {
    await getRepository(Media).save(
      new Media({ tmdbId: 7001, mediaType: MediaType.MOVIE })
    );
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal((await columnsOf()).has('quality'), false);

      await migration.up(runner);
      const column = (await columnsOf()).get('quality');
      assert.equal(column?.type, 'text');
      assert.equal(column?.isNullable, true);
    } finally {
      await runner.release();
    }

    const media = await getRepository(Media).findOneByOrFail({ tmdbId: 7001 });
    assert.equal(media.quality, null);
    assert.equal(media.availableQuality, undefined);

    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /"quality"/.test(query)),
      []
    );
  });
});
