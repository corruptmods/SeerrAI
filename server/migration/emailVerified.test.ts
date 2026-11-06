import dataSource, { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { AddEmailVerified1797850000000 as PostgresMigration } from '@server/migration/postgres/1797850000000-AddEmailVerified';
import { AddEmailVerified1797850000000 as SqliteMigration } from '@server/migration/sqlite/1797850000000-AddEmailVerified';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The column that says whether a user's email is confirmed, added by the
 * migration for whichever database the tests run on (DB_TYPE=postgres for
 * Postgres).
 */

setupTestDb();

const columnsOf = async () => {
  const runner = dataSource.createQueryRunner();
  try {
    const table = await runner.getTable('user');
    return new Map(table?.columns.map((column) => [column.name, column]));
  } finally {
    await runner.release();
  }
};

describe('the email confirmation migration', () => {
  it('counts every existing email as confirmed, and agrees with the entity', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal((await columnsOf()).has('emailVerified'), false);

      await migration.up(runner);
      const column = (await columnsOf()).get('emailVerified');
      assert.equal(column?.type, 'boolean');
      assert.equal(column?.isNullable, false);
    } finally {
      await runner.release();
    }

    const users = await getRepository(User).find();
    assert.ok(users.length > 0);
    assert.ok(users.every((user) => user.emailVerified === true));

    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /emailVerified/.test(query)),
      []
    );
  });
});
