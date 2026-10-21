import dataSource, { getRepository } from '@server/datasource';
import DownloadCheck from '@server/entity/DownloadCheck';
import { AddDownloadCheck1795900000000 as PostgresMigration } from '@server/migration/postgres/1795900000000-AddDownloadCheck';
import { AddDownloadCheck1795900000000 as SqliteMigration } from '@server/migration/sqlite/1795900000000-AddDownloadCheck';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Download Check's table, made by the migration for whichever database the
 * tests run on (DB_TYPE=postgres for Postgres), the way the entity expects:
 * a finding saved and read back, one row a download and stage.
 */

setupTestDb();

describe('the Download Check migration', () => {
  it('makes the table the entity expects, and takes it away again', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal(await runner.hasTable('download_check'), false);
      await migration.up(runner);
      assert.equal(await runner.hasTable('download_check'), true);
    } finally {
      await runner.release();
    }

    const at = new Date('2026-10-20T12:00:00Z');
    const row = (stage: 'grab' | 'import') =>
      new DownloadCheck({
        app: 'sonarr',
        serverId: 0,
        downloadKey: 'abc',
        stage,
        title: 'Show.S01E03.1080p',
        itemId: 10,
        itemTitle: 'Show',
        finding: 'early',
        action: 'reject',
        status: 'would',
        createdAt: at,
        updatedAt: at,
      });
    const saved = await getRepository(DownloadCheck).save(row('grab'));
    const back = await getRepository(DownloadCheck).findOneOrFail({
      where: { id: saved.id },
    });
    assert.equal(back.params, '{}');
    assert.equal(back.detail, '');
    assert.equal(back.episodes, '');
    assert.equal(back.createdAt.toISOString(), at.toISOString());
    // The same download and stage twice is refused; another stage isn't.
    await assert.rejects(getRepository(DownloadCheck).save(row('grab')));
    await getRepository(DownloadCheck).save(row('import'));
    assert.equal(await getRepository(DownloadCheck).count(), 2);
  });
});
