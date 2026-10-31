import dataSource, { getRepository } from '@server/datasource';
import QualityManaged from '@server/entity/QualityManaged';
import { AddQualityProfiles1796900000000 as PostgresMigration } from '@server/migration/postgres/1796900000000-AddQualityProfiles';
import { AddQualityProfiles1796900000000 as SqliteMigration } from '@server/migration/sqlite/1796900000000-AddQualityProfiles';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The quality profile tables, made by the migration for whichever database
 * the tests run on (DB_TYPE=postgres for Postgres), and nothing left for
 * the schema to change after it.
 */

setupTestDb();

const TABLES = [
  'quality_apply',
  'quality_grab_note',
  'quality_managed',
  'quality_step_down',
];

describe('the quality profiles migration', () => {
  it('makes the tables, and takes them away again', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      for (const table of TABLES) {
        assert.equal(await runner.hasTable(table), false, table);
      }
      await migration.up(runner);
      for (const table of TABLES) {
        assert.equal(await runner.hasTable(table), true, table);
      }
    } finally {
      await runner.release();
    }

    const repo = getRepository(QualityManaged);
    await repo.save(
      new QualityManaged({
        serverKind: 'radarr',
        serverId: 0,
        itemKind: 'profile',
        key: '1080p',
        arrId: 12,
        fingerprint: 'f',
      })
    );
    // One row per item per server.
    await assert.rejects(
      repo.save(
        new QualityManaged({
          serverKind: 'radarr',
          serverId: 0,
          itemKind: 'profile',
          key: '1080p',
          arrId: 13,
          fingerprint: 'g',
        })
      )
    );

    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /quality_/.test(query)),
      []
    );
  });
});
