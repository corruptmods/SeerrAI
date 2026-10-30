import dataSource, { getRepository } from '@server/datasource';
import { MediaList } from '@server/entity/MediaList';
import { User } from '@server/entity/User';
import { AddPlaylists1796800000000 as PostgresMigration } from '@server/migration/postgres/1796800000000-AddPlaylists';
import { AddPlaylists1796800000000 as SqliteMigration } from '@server/migration/sqlite/1796800000000-AddPlaylists';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The playlists migration, for whichever database the tests run on
 * (DB_TYPE=postgres for Postgres): lists made before it are watch lists,
 * and what it makes is exactly what the entities describe.
 */

setupTestDb();

describe('the playlists migration', () => {
  it('makes lists already there watch lists, and matches the entities', async () => {
    const owner = await getRepository(User).save(
      new User({ email: 'pl-owner@test.local', avatar: '' })
    );
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal(await runner.hasTable('media_list_song'), false);
      assert.equal(await runner.hasColumn('media_list', 'kind'), false);
      await runner.query(
        `INSERT INTO "media_list" ("name", "ownerId") VALUES ('Friday films', ${owner.id})`
      );

      await migration.up(runner);
      const old = await getRepository(MediaList).findOneByOrFail({
        name: 'Friday films',
      });
      assert.equal(old.kind, 'watch');
      assert.equal(old.sourceUrl, null);

      // Nothing left for TypeORM to change: the migration made the schema
      // the entities describe.
      const pending = await dataSource.driver.createSchemaBuilder().log();
      const ours = pending.upQueries
        .map((q) => q.query)
        .filter((q) => /media_list/.test(q));
      assert.deepEqual(ours, []);
    } finally {
      await runner.release();
    }
  });
});
