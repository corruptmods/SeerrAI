import dataSource, { getRepository } from '@server/datasource';
import { MediaList, MediaListSong } from '@server/entity/MediaList';
import { User } from '@server/entity/User';
import { AddPlaylists1796800000000 as PostgresMigration } from '@server/migration/postgres/1796800000000-AddPlaylists';
import { AddPlaylistSongCatalog1797500000000 as PostgresCatalog } from '@server/migration/postgres/1797500000000-AddPlaylistSongCatalog';
import { AddPlaylists1796800000000 as SqliteMigration } from '@server/migration/sqlite/1796800000000-AddPlaylists';
import { AddPlaylistSongCatalog1797500000000 as SqliteCatalog } from '@server/migration/sqlite/1797500000000-AddPlaylistSongCatalog';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The playlists migrations, for whichever database the tests run on
 * (DB_TYPE=postgres for Postgres): lists made before them are watch lists,
 * songs MusicBrainz didn't know are looked up again, and what they make is
 * exactly what the entities describe.
 */

setupTestDb();

describe('the playlists migration', () => {
  it('makes lists already there watch lists, and matches the entities', async () => {
    const owner = await getRepository(User).save(
      new User({ email: 'pl-owner@test.local', avatar: '' })
    );
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const catalog = isPgsql ? new PostgresCatalog() : new SqliteCatalog();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal(await runner.hasTable('media_list_song'), false);
      assert.equal(await runner.hasColumn('media_list', 'kind'), false);
      await runner.query(
        `INSERT INTO "media_list" ("name", "ownerId") VALUES ('Friday films', ${owner.id})`
      );

      await migration.up(runner);
      await catalog.up(runner);
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

  it('looks up again the songs MusicBrainz didn’t know', async () => {
    const owner = await getRepository(User).save(
      new User({ email: 'pl-catalog@test.local', avatar: '' })
    );
    const list = await getRepository(MediaList).save(
      new MediaList({ name: 'Drives', kind: 'music', ownerId: owner.id })
    );
    const song = (sourceId: string, state: MediaListSong['state']) =>
      new MediaListSong({
        listId: list.id,
        sourceId,
        title: sourceId,
        artistName: 'Glasswing',
        state,
      });
    await getRepository(MediaListSong).save([
      song('Unheard Tune', 'unmatched'),
      song('Lantern Song', 'requested'),
    ]);
    const catalog = isPgsql ? new PostgresCatalog() : new SqliteCatalog();
    const runner = dataSource.createQueryRunner();
    try {
      await catalog.down(runner);
      assert.equal(await runner.hasColumn('media_list_song', 'isrc'), false);
      await catalog.up(runner);
      const states = Object.fromEntries(
        (await getRepository(MediaListSong).find()).map((s) => [
          s.sourceId,
          s.state,
        ])
      );
      assert.deepEqual(states, {
        'Unheard Tune': 'matching',
        'Lantern Song': 'requested',
      });
    } finally {
      await runner.release();
    }
  });
});
