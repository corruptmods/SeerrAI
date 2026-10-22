import dataSource, { getRepository } from '@server/datasource';
import UserApiKey from '@server/entity/UserApiKey';
import { makeKey } from '@server/lib/personalApiKeys';
import { AddApiKeyScope1796000000000 as PostgresMigration } from '@server/migration/postgres/1796000000000-AddApiKeyScope';
import { AddApiKeyScope1796000000000 as SqliteMigration } from '@server/migration/sqlite/1796000000000-AddApiKeyScope';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The column that says a key is a Siri key, made by the migration for
 * whichever database the tests run on (DB_TYPE=postgres for Postgres).
 * Keys made before it are full keys, as they were.
 */

setupTestDb();

const key = (scope?: 'siri') => {
  const made = makeKey();
  return new UserApiKey({
    userId: 1,
    publicId: made.publicId,
    secretHash: made.secretHash,
    name: scope ? 'Siri' : 'Home Assistant',
    scope,
  });
};

describe('the API key scope migration', () => {
  it('adds the column, leaving keys made before it as full keys', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      assert.equal(await runner.hasColumn('user_api_key', 'scope'), false);
      const made = makeKey();
      await runner.query(
        `INSERT INTO "user_api_key" ("userId", "publicId", "secretHash", "name") VALUES (1, '${made.publicId}', '${made.secretHash}', 'Old')`
      );

      await migration.up(runner);
      assert.equal(await runner.hasColumn('user_api_key', 'scope'), true);
      const old = await getRepository(UserApiKey).findOneOrFail({
        where: { publicId: made.publicId },
      });
      assert.equal(old.scope, null);

      const siri = await getRepository(UserApiKey).save(key('siri'));
      const full = await getRepository(UserApiKey).save(key());
      assert.equal(
        (await getRepository(UserApiKey).findOneByOrFail({ id: siri.id }))
          .scope,
        'siri'
      );
      assert.equal(
        (await getRepository(UserApiKey).findOneByOrFail({ id: full.id }))
          .scope,
        null
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
        .filter((query) => /user_api_key/.test(query)),
      []
    );
  });
});
