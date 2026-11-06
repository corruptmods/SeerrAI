import dataSource from '@server/datasource';
import { AddDiscordApprovalMessage1798100000000 as PostgresMigration } from '@server/migration/postgres/1798100000000-AddDiscordApprovalMessage';
import { AddDiscordApprovalMessage1798100000000 as SqliteMigration } from '@server/migration/sqlite/1798100000000-AddDiscordApprovalMessage';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The table of the Discord bot's Approve and Decline messages, added by the
 * migration for whichever database the tests run on (DB_TYPE=postgres for
 * Postgres).
 */

setupTestDb();

const tableExists = async () => {
  const runner = dataSource.createQueryRunner();
  try {
    return await runner.hasTable('discord_approval_message');
  } finally {
    await runner.release();
  }
};

describe('the Discord bot messages migration', () => {
  it('adds the table the entity expects, and takes it away again', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal(await tableExists(), false);
      await migration.up(runner);
      assert.equal(await tableExists(), true);
    } finally {
      await runner.release();
    }

    // Nothing about it left for the schema to change: the migration and the
    // entity agree.
    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /discord_approval_message/.test(query)),
      []
    );
  });
});
