import dataSource, { getRepository } from '@server/datasource';
import AutoFixMark from '@server/entity/AutoFixMark';
import { AddAutoFixMarks1797800000006 as PostgresMigration } from '@server/migration/postgres/1797800000006-AddAutoFixMarks';
import { AddAutoFixMarks1797800000006 as SqliteMigration } from '@server/migration/sqlite/1797800000006-AddAutoFixMarks';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The table auto-fix keeps its daily allowances and recent fixes in, made
 * by the migration for whichever database the tests run on (DB_TYPE=postgres
 * for Postgres), just as the entity expects.
 */

setupTestDb();

describe('the auto-fix marks migration', () => {
  it('makes the table the entity expects', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal(await runner.hasTable('auto_fix_mark'), false);
      await migration.up(runner);
      assert.equal(await runner.hasTable('auto_fix_mark'), true);
    } finally {
      await runner.release();
    }

    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((q) => q.query)
        .filter((query) => query.includes('auto_fix_mark')),
      []
    );

    const marks = getRepository(AutoFixMark);
    await marks.upsert(
      { key: 'use:fix:2:2026-11-05', count: 1, at: new Date() },
      ['key']
    );
    await marks.upsert(
      { key: 'use:fix:2:2026-11-05', count: 2, at: new Date() },
      ['key']
    );
    const kept = await marks.find();
    assert.equal(kept.length, 1);
    assert.equal(kept[0].count, 2);
  });
});
