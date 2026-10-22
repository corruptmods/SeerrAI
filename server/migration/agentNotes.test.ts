import dataSource, { getRepository } from '@server/datasource';
import BackfillSeries from '@server/entity/BackfillSeries';
import { AddAgentNotes1796100000000 as PostgresMigration } from '@server/migration/postgres/1796100000000-AddAgentNotes';
import { AddAgentNotes1796100000000 as SqliteMigration } from '@server/migration/sqlite/1796100000000-AddAgentNotes';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The column that keeps what the admin agent tried for each title, made by
 * the migration for whichever database the tests run on (DB_TYPE=postgres
 * for Postgres). Titles followed before it start with no notes.
 */

setupTestDb();

describe('the agent notes migration', () => {
  it('adds the column, with no notes for the titles already there', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal(
        await runner.hasColumn('backfill_series', 'agentNotes'),
        false
      );
      await runner.query(
        `INSERT INTO "backfill_series" ("kind", "serverId", "arrId", "title") VALUES ('series', 0, 5150, 'Far Afield')`
      );

      await migration.up(runner);
      assert.equal(
        await runner.hasColumn('backfill_series', 'agentNotes'),
        true
      );
      const read = () =>
        getRepository(BackfillSeries).findOneOrFail({
          select: { id: true, agentNotes: true },
          where: { arrId: 5150 },
        });
      const old = await read();
      assert.deepEqual(old.agentNotes, []);

      await getRepository(BackfillSeries).update(old.id, {
        agentNotes: [
          {
            at: new Date().toISOString(),
            kind: 'searched',
            what: 'Far Afield',
          },
        ],
      });
      assert.equal((await read()).agentNotes[0].what, 'Far Afield');
      // Left out of what the rest of Seerr reads.
      assert.equal(
        (await getRepository(BackfillSeries).findOneByOrFail({ id: old.id }))
          .agentNotes,
        undefined
      );
    } finally {
      await runner.release();
    }

    // Nothing left for the schema to change: the migration and the entity
    // agree.
    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /backfill_series/.test(query)),
      []
    );
  });
});
