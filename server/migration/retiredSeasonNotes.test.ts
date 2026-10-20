import { UserType } from '@server/constants/user';
import dataSource, { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { ClearRetiredSeasonNotes1795500000000 as PostgresMigration } from '@server/migration/postgres/1795500000000-ClearRetiredSeasonNotes';
import { ClearRetiredSeasonNotes1795500000000 as SqliteMigration } from '@server/migration/sqlite/1795500000000-ClearRetiredSeasonNotes';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Diwali and Pride Month were seasonal themes. Someone's answer to one's
 * note ("diwali-2026:off") is cleared, by the migration for whichever
 * database the tests run on (DB_TYPE=postgres for Postgres); answers about
 * the seasons there still are stay.
 */

setupTestDb();

const noteOf = async (userId: number) =>
  (
    await getRepository(UserSettings).findOneOrFail({
      where: { user: { id: userId } },
    })
  ).seasonNote ?? null;

/** Someone with this answer to a season's note kept. */
const personWith = async (name: string, seasonNote: string | null) => {
  const user = await getRepository(User).save(
    new User({
      email: `${name}@seerr.dev`,
      username: name,
      userType: UserType.LOCAL,
      permissions: 0,
      avatar: '',
    })
  );
  await getRepository(UserSettings).save(
    new UserSettings({ user, seasonNote })
  );
  return user.id;
};

describe('the retired season notes migration', () => {
  it('clears answers about Diwali and Pride Month, and only those', async () => {
    const people = {
      diwali: await personWith('diwali', 'diwali-2026:off'),
      pride: await personWith('pride', 'pride-2026:keep'),
      halloween: await personWith('halloween', 'halloween-2026:off'),
      none: await personWith('none', null),
    };

    const migration = isPgsql ? new PostgresMigration() : new SqliteMigration();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.up(runner);
      // Running it again changes nothing.
      await migration.up(runner);
    } finally {
      await runner.release();
    }

    assert.equal(await noteOf(people.diwali), null);
    assert.equal(await noteOf(people.pride), null);
    assert.equal(await noteOf(people.halloween), 'halloween-2026:off');
    assert.equal(await noteOf(people.none), null);
  });
});
