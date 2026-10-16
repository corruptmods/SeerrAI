import dataSource, { getRepository } from '@server/datasource';
import { MediaList } from '@server/entity/MediaList';
import { User } from '@server/entity/User';
import { WidenPermissions1794100000000 } from '@server/migration/sqlite/1794100000000-WidenPermissions';
import { setupTestDb } from '@server/test/db';
import { isPgsql } from '@server/utils/dbType';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Undoing the SQLite migration that widened permissions rebuilds the
 * accounts table. With foreign keys on, dropping the old table would
 * delete everything that belongs to an account, so it refuses.
 */

setupTestDb();

const seedList = async () => {
  const owner = await getRepository(User).findOneByOrFail({ id: 1 });
  await getRepository(MediaList).save(
    new MediaList({ name: 'Weekend', owner, ownerId: owner.id })
  );
};

describe('undoing the widened permissions on SQLite', { skip: isPgsql }, () => {
  it('refuses with foreign keys on, as in a transaction, and loses nothing', async () => {
    await seedList();
    const runner = dataSource.createQueryRunner();
    try {
      // How TypeORM reverts by default: in a transaction, where turning
      // foreign keys off has no effect.
      await runner.startTransaction();
      await runner.beforeMigration();
      await assert.rejects(
        new WidenPermissions1794100000000().down(runner),
        /foreign keys/
      );
      await runner.rollbackTransaction();
      await runner.afterMigration();
    } finally {
      await runner.release();
    }
    assert.equal(await getRepository(MediaList).count(), 1);
    assert.equal(await getRepository(User).count(), 2);
  });

  it('goes ahead with foreign keys off, keeping what belongs to each account', async () => {
    await seedList();
    const runner = dataSource.createQueryRunner();
    try {
      await runner.query('PRAGMA foreign_keys = OFF');
      await new WidenPermissions1794100000000().down(runner);
      await new WidenPermissions1794100000000().up(runner);
    } finally {
      await runner.query('PRAGMA foreign_keys = ON');
      await runner.release();
    }
    assert.equal(await getRepository(MediaList).count(), 1);
    assert.equal(await getRepository(User).count(), 2);
  });
});
