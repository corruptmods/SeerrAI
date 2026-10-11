import PlexTvAPI from '@server/api/plextv';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import plexUserImport from '@server/lib/plexUserImport';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import request from 'supertest';

/*
 * Auto-import: who gets an account, and that nobody existing is touched.
 */

const MACHINE = 'this-server';
const server = (machineIdentifier: string) => ({ $: { machineIdentifier } });
const plexUser = (
  id: string,
  email: string,
  servers: ReturnType<typeof server>[]
) => ({
  $: { id, title: id, username: `user${id}`, email, thumb: `thumb${id}` },
  Server: servers,
});

let shared: ReturnType<typeof plexUser>[] = [];
Object.defineProperty(PlexTvAPI.prototype, 'getUsers', {
  configurable: true,
  set() {},
  get() {
    return async () => ({ MediaContainer: { User: shared } });
  },
});

setupTestDb();

beforeEach(async () => {
  const settings = getSettings();
  settings.main.autoImportPlexUsers = true;
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.main.defaultPermissions = Permission.REQUEST;
  settings.plex.machineId = MACHINE;
  await getRepository(User).update({ id: 1 }, { plexToken: 'owner-token' });

  shared = [
    plexUser('501', 'new@example.com', [server(MACHINE)]),
    plexUser('502', 'elsewhere@example.com', [server('another-server')]),
    plexUser('503', '', [server(MACHINE)]),
    // Already has an account (the seeded friend), matched by email.
    plexUser('504', 'FRIEND@seerr.dev', [server(MACHINE)]),
  ];
});

const byEmail = (email: string) =>
  getRepository(User).findOne({ where: { email } });

describe('Plex user auto-import', () => {
  it('adds friends with access to this server, with default permissions', async () => {
    const created = await plexUserImport.run();
    assert.deepEqual(
      created.map((u) => u.email),
      ['new@example.com']
    );

    const user = await byEmail('new@example.com');
    assert.ok(user);
    assert.equal(user.plexId, 501);
    assert.equal(user.userType, UserType.PLEX);
    assert.equal(user.permissions, Permission.REQUEST);

    assert.equal(await byEmail('elsewhere@example.com'), null, 'no access');
  });

  it('leaves existing accounts exactly as they are', async () => {
    const before = await byEmail('friend@seerr.dev');
    await plexUserImport.run();
    const after = await byEmail('friend@seerr.dev');
    assert.equal(after?.plexId, before?.plexId);
    assert.equal(after?.avatar, before?.avatar);
    assert.equal(after?.userType, before?.userType);
    assert.equal(after?.permissions, before?.permissions);
  });

  it('adds nobody twice', async () => {
    await plexUserImport.run();
    assert.deepEqual(await plexUserImport.run(), []);
    assert.equal(
      await getRepository(User).count({ where: { email: 'new@example.com' } }),
      1
    );
  });

  it('does nothing while turned off', async () => {
    getSettings().main.autoImportPlexUsers = false;
    assert.deepEqual(await plexUserImport.run(), []);
    assert.equal(await byEmail('new@example.com'), null);
  });
});

describe('a Plex user an admin deleted', () => {
  const app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/user', isAuthenticated(), userRoutes);

  const deleteAsOwner = async (userId: number) => {
    getSettings().main.localLogin = true;
    const agent = request.agent(app);
    const signIn = await agent
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'test1234' });
    assert.equal(signIn.status, 200);
    return agent.delete(`/user/${userId}`);
  };

  it('is not brought back by the next import', async () => {
    await plexUserImport.run();
    const imported = await byEmail('new@example.com');
    assert.ok(imported);

    assert.equal((await deleteAsOwner(imported.id)).status, 200);
    assert.deepEqual(await plexUserImport.run(), []);
    assert.equal(await byEmail('new@example.com'), null);
  });

  it('does not stop anyone else being imported', async () => {
    await plexUserImport.run();
    const imported = await byEmail('new@example.com');
    assert.ok(imported);
    await deleteAsOwner(imported.id);

    shared.push(plexUser('505', 'later@example.com', [server(MACHINE)]));
    assert.deepEqual(
      (await plexUserImport.run()).map((u) => u.email),
      ['later@example.com']
    );
  });
});
