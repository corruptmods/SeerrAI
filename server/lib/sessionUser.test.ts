import dataSource, { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { Permission } from '@server/lib/permissions';
import { sessionUser } from '@server/lib/sessionUser';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

setupTestDb();

afterEach(() => mock.restoreAll());

/*
 * A page's first API calls share one read of the signed-in user. Changes to
 * them (permissions, deletion, settings) must still show on the next request.
 */

const countReads = () => {
  const repository = getRepository(User);
  const findOne = repository.findOne.bind(repository);
  return mock.method(repository, 'findOne', (...args: unknown[]) =>
    findOne(...(args as Parameters<typeof findOne>))
  );
};

const friendId = async (): Promise<number> =>
  (
    await getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    })
  ).id;

describe('the signed-in user', () => {
  it('is read once for calls that arrive together', async () => {
    const id = await friendId();
    const reads = countReads();

    const users = await Promise.all(
      Array.from({ length: 10 }, () => sessionUser(id))
    );

    assert.equal(reads.mock.callCount(), 1);
    for (const user of users) {
      assert.equal(user?.email, 'friend@seerr.dev');
    }
  });

  it('gives each call its own copy', async () => {
    const id = await friendId();
    const saved = await getRepository(User).findOneOrFail({ where: { id } });
    saved.settings = Object.assign(new UserSettings(), { locale: 'en' });
    await getRepository(User).save(saved);

    const first = await sessionUser(id);
    assert.ok(first instanceof User);
    assert.ok(first.settings instanceof UserSettings);
    first.permissions = Permission.ADMIN;
    first.warnings.push('changed here only');
    first.settings.locale = 'fr';

    const second = await sessionUser(id);
    assert.notEqual(second?.permissions, Permission.ADMIN);
    assert.deepEqual(second?.warnings, []);
    assert.equal(second?.hasPermission(Permission.ADMIN), false);
    assert.equal(second?.settings?.locale, 'en');
  });

  it('shows a saved permission change on the next call', async () => {
    const id = await friendId();
    assert.equal(
      (await sessionUser(id))?.hasPermission(Permission.ADMIN),
      false
    );

    const user = await getRepository(User).findOneOrFail({ where: { id } });
    user.permissions = Permission.ADMIN;
    await getRepository(User).save(user);

    assert.equal(
      (await sessionUser(id))?.hasPermission(Permission.ADMIN),
      true
    );
  });

  it('shows a change made with update on the next call', async () => {
    const id = await friendId();
    await sessionUser(id);

    await getRepository(User).update(id, { permissions: Permission.ADMIN });

    assert.equal((await sessionUser(id))?.permissions, Permission.ADMIN);
  });

  it('shows a settings change on the next call', async () => {
    const id = await friendId();
    await sessionUser(id);

    const user = await getRepository(User).findOneOrFail({ where: { id } });
    user.settings = Object.assign(user.settings ?? new UserSettings(), {
      locale: 'de',
    });
    await getRepository(User).save(user);

    assert.equal((await sessionUser(id))?.settings?.locale, 'de');
  });

  it('is gone on the next call once deleted', async () => {
    const id = await friendId();
    assert.ok(await sessionUser(id));

    await getRepository(User).delete(id);

    assert.equal(await sessionUser(id), null);
  });

  it('never reuses a read that started before a change', async () => {
    const id = await friendId();
    const before = sessionUser(id);
    await getRepository(User).update(id, { permissions: Permission.ADMIN });
    await before;

    assert.equal((await sessionUser(id))?.permissions, Permission.ADMIN);
  });

  it('shows the database once a transaction ends, committed or not', async () => {
    const id = await friendId();
    const was = (await sessionUser(id))?.permissions;

    await assert.rejects(
      dataSource.transaction(async (manager) => {
        await manager.update(User, id, { permissions: Permission.ADMIN });
        // Read during the transaction (on SQLite, its own uncommitted write).
        await sessionUser(id);
        throw new Error('undone');
      }),
      /undone/
    );
    assert.equal((await sessionUser(id))?.permissions, was);

    await dataSource.transaction(async (manager) => {
      await manager.update(User, id, { permissions: Permission.ADMIN });
      await sessionUser(id);
    });
    assert.equal((await sessionUser(id))?.permissions, Permission.ADMIN);
  });
});
