import dataSource, { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import UserApiKey from '@server/entity/UserApiKey';
import { AddUserApiKey1795700000000 as PostgresMigration } from '@server/migration/postgres/1795700000000-AddUserApiKey';
import { AddUserApiKey1795700000000 as SqliteMigration } from '@server/migration/sqlite/1795700000000-AddUserApiKey';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The table of personal API keys, added by the migration for whichever
 * database the tests run on (DB_TYPE=postgres for Postgres).
 */

setupTestDb();

const tableExists = async () => {
  const runner = dataSource.createQueryRunner();
  try {
    return await runner.hasTable('user_api_key');
  } finally {
    await runner.release();
  }
};

const keyFor = (user: User, publicId: string) =>
  getRepository(UserApiKey).save(
    new UserApiKey({
      user,
      publicId,
      secretHash: 'a'.repeat(64),
      name: 'Home Assistant',
    })
  );

describe('the personal API keys migration', () => {
  it('adds the table the entity expects, and takes it away again', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal(await tableExists(), false);
      await migration.up(runner);
      assert.equal(await tableExists(), true);

      const table = await runner.getTable('user_api_key');
      const columns = new Map(
        table?.columns.map((column) => [column.name, column])
      );
      assert.equal(columns.get('secretHash')?.isNullable, false);
      assert.equal(columns.get('expiresAt')?.isNullable, true);
      assert.equal(columns.get('lastUsedAt')?.isNullable, true);
    } finally {
      await runner.release();
    }

    // Nothing about it left for the schema to change: the migration and the
    // entity agree.
    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /user_api_key/.test(query)),
      []
    );
  });

  it('gives every key its own visible id', async () => {
    const admin = await getRepository(User).findOneOrFail({
      where: { id: 1 },
    });
    await keyFor(admin, 'ab12cd34');
    await assert.rejects(keyFor(admin, 'ab12cd34'));
  });

  it('goes with the account it belongs to', async () => {
    const users = getRepository(User);
    const friend = await users.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    await keyFor(friend, '0f0f0f0f');

    await users.delete(friend.id);

    assert.equal(await getRepository(UserApiKey).count(), 0);
  });
});
