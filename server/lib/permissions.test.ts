import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { Permission, hasPermission } from '@server/lib/permissions';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Auto-Approve Music is 2^31: past what a 32-bit `&` and an integer column
 * hold. Permission checks and the database both have to keep it.
 */

const HIGH = 2 ** 33;

describe('permission checks', () => {
  it('give music its own two permissions', () => {
    assert.equal(Permission.REQUEST_MUSIC, 2 ** 29);
    assert.equal(Permission.AUTO_APPROVE_MUSIC, 2 ** 31);
  });

  it('see a permission at 2^31 and above', () => {
    const value = Permission.REQUEST + Permission.AUTO_APPROVE_MUSIC + HIGH;
    assert.equal(hasPermission(Permission.AUTO_APPROVE_MUSIC, value), true);
    assert.equal(hasPermission(HIGH as Permission, value), true);
    assert.equal(hasPermission(Permission.REQUEST, value), true);
    assert.equal(hasPermission(Permission.REQUEST_MUSIC, value), false);
    assert.equal(hasPermission(Permission.AUTO_APPROVE, value), false);
  });

  it('do not mistake a high bit for a low one', () => {
    // With `&`, 2^32 + 2 wrapped to 2 and read as an admin.
    assert.equal(hasPermission(Permission.ADMIN, 2 ** 32), false);
    assert.equal(
      hasPermission(Permission.AUTO_APPROVE_MUSIC, Permission.ADMIN * 2),
      false
    );
  });

  it('combine high bits with "and" and "or"', () => {
    const value = Permission.AUTO_APPROVE_MUSIC + Permission.MANAGE_REQUESTS;
    assert.equal(
      hasPermission(
        [Permission.AUTO_APPROVE_MUSIC, Permission.MANAGE_REQUESTS],
        value
      ),
      true
    );
    assert.equal(
      hasPermission(
        [Permission.AUTO_APPROVE_MUSIC, Permission.REQUEST_MUSIC],
        value
      ),
      false
    );
    assert.equal(
      hasPermission(
        [Permission.REQUEST_MUSIC, Permission.AUTO_APPROVE_MUSIC],
        value,
        { type: 'or' }
      ),
      true
    );
    assert.equal(
      hasPermission([Permission.REQUEST_MUSIC, Permission.REQUEST], value, {
        type: 'or',
      }),
      false
    );
  });

  it('let an admin through whatever else is set', () => {
    const value = Permission.ADMIN + Permission.AUTO_APPROVE_MUSIC;
    assert.equal(hasPermission(Permission.REQUEST_MUSIC, value), true);
    assert.equal(
      hasPermission([Permission.REQUEST_MUSIC, Permission.VOTE], value),
      true
    );
  });

  it('treat no permission as always held', () => {
    assert.equal(hasPermission(Permission.NONE, 0), true);
  });
});

describe('stored permissions', () => {
  setupTestDb();

  it('keep bits at 2^31 and above, read back as a number', async () => {
    const value =
      Permission.REQUEST +
      Permission.REQUEST_MUSIC +
      Permission.AUTO_APPROVE_MUSIC +
      HIGH;
    await getRepository(User).update(2, { permissions: value });

    const user = await getRepository(User).findOneOrFail({ where: { id: 2 } });
    assert.equal(typeof user.permissions, 'number');
    assert.equal(user.permissions, value);
    assert.equal(user.hasPermission(Permission.AUTO_APPROVE_MUSIC), true);
    assert.equal(user.hasPermission(Permission.ADMIN), false);
  });

  it('can still be tested for admin in SQL', async () => {
    await getRepository(User).update(2, {
      permissions: Permission.REQUEST + Permission.AUTO_APPROVE_MUSIC,
    });
    await getRepository(User).update(1, {
      permissions: Permission.ADMIN + Permission.AUTO_APPROVE_MUSIC,
    });

    const admins = await getRepository(User)
      .createQueryBuilder('user')
      .where(`(user.permissions & ${Permission.ADMIN}) != 0`)
      .getMany();
    assert.deepEqual(
      admins.map((user) => user.id),
      [1]
    );
  });
});
