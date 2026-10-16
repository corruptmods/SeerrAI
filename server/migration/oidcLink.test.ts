import dataSource, { getRepository } from '@server/datasource';
import OidcLink from '@server/entity/OidcLink';
import { User } from '@server/entity/User';
import { AddOidcLink1794700000000 as PostgresMigration } from '@server/migration/postgres/1794700000000-AddOidcLink';
import { AddOidcLinkIssuer1794800000000 as PostgresIssuerMigration } from '@server/migration/postgres/1794800000000-AddOidcLinkIssuer';
import { AddOidcLink1794700000000 as SqliteMigration } from '@server/migration/sqlite/1794700000000-AddOidcLink';
import { AddOidcLinkIssuer1794800000000 as SqliteIssuerMigration } from '@server/migration/sqlite/1794800000000-AddOidcLinkIssuer';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * The table of single sign-on links, added by the migrations for whichever
 * database the tests run on (DB_TYPE=postgres for Postgres): the table,
 * then the issuer each link was made at.
 */

setupTestDb();

const tableExists = async () => {
  const runner = dataSource.createQueryRunner();
  try {
    return await runner.hasTable('oidc_link');
  } finally {
    await runner.release();
  }
};

describe('the single sign-on links migration', () => {
  it('adds the table the entity expects, and takes it away again', async () => {
    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const issuer = isPgsql
      ? new PostgresIssuerMigration()
      : new SqliteIssuerMigration();
    const runner = dataSource.createQueryRunner();
    const hasIssuer = async () =>
      !!(await runner.getTable('oidc_link'))?.findColumnByName('issuer');
    try {
      await issuer.down(runner);
      assert.equal(await hasIssuer(), false);
      await migration.down(runner);
      assert.equal(await tableExists(), false);
      await migration.up(runner);
      assert.equal(await tableExists(), true);
      await issuer.up(runner);
      assert.equal(await hasIssuer(), true);

      const table = await runner.getTable('oidc_link');
      const unique = (table?.indices ?? [])
        .filter((index) => index.isUnique)
        .map((index) => [...index.columnNames].sort().join('+'))
        .sort();
      assert.deepEqual(unique, ['provider+sub', 'provider+userId']);
    } finally {
      await runner.release();
    }

    // Nothing about it left for the schema to change: the migration and the
    // entity agree.
    const pending = await dataSource.driver.createSchemaBuilder().log();
    assert.deepEqual(
      pending.upQueries
        .map((query) => query.query)
        .filter((query) => /oidc_link/.test(query)),
      []
    );
  });

  it('holds one link per provider account, and one per person per provider', async () => {
    const links = getRepository(OidcLink);
    const [admin, friend] = await getRepository(User).find({
      order: { id: 'ASC' },
    });
    await links.save(
      new OidcLink({ user: admin, provider: 'authentik', sub: 'a' })
    );

    await assert.rejects(
      links.save(
        new OidcLink({ user: friend, provider: 'authentik', sub: 'a' })
      )
    );
    await assert.rejects(
      links.save(new OidcLink({ user: admin, provider: 'authentik', sub: 'b' }))
    );
    // The same id at another provider is someone else.
    await links.save(
      new OidcLink({ user: friend, provider: 'google', sub: 'a' })
    );
    assert.equal(await links.count(), 2);
  });

  it('goes with the account it belongs to', async () => {
    const links = getRepository(OidcLink);
    const users = getRepository(User);
    const friend = await users.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    await links.save(
      new OidcLink({ user: friend, provider: 'authentik', sub: 'f' })
    );

    await users.delete(friend.id);

    assert.equal(await links.count(), 0);
  });
});
