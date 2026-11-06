import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { saveFirstOwner } from '@server/lib/firstOwner';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

const account = (email: string) => new User({ email, avatar: '' });

describe('the first owner', () => {
  it('is account 1 even after every account was deleted', async () => {
    const users = getRepository(User);
    await users.save([
      account('glasswing@example.invalid'),
      account('static-garden@example.invalid'),
    ]);
    await users.createQueryBuilder().delete().execute();

    const owner = await saveFirstOwner(account('lantern-song@example.invalid'));
    assert.equal(owner.id, 1);
    const next = await users.save(account('harbour-lights@example.invalid'));
    // Later accounts carry on without clashing (SQLite from its old high).
    assert.ok(next.id > 1);
  });
});
