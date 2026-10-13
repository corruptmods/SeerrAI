import assert from 'node:assert/strict';
import { before, describe, it, mock } from 'node:test';

import PlexTvAPI from '@server/api/plextv';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import userRoutes from '.';

// Everyone signing in here with a password is on the owner's Plex share
// list.
mock.method(PlexTvAPI.prototype, 'checkUserAccess', async () => true);

let app: Express;

before(() => {
  app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/user', isAuthenticated(), userRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // Express knows an error handler by its four parameters.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );
});

setupTestDb();

const loginAs = async (email: string, password = 'test1234') => {
  getSettings().main.localLogin = true;
  const agent = request.agent(app);
  const res = await agent.post('/auth/local').send({ email, password });
  assert.equal(res.status, 200);
  return { agent, id: res.body.id as number };
};

const permissionsOf = async (id: number) =>
  (await getRepository(User).findOneByOrFail({ id })).permissions;

/*
 * The seeded friend becomes someone who manages users without being an
 * admin; beside them, a second admin and an ordinary user.
 */
const people = async () => {
  const users = getRepository(User);
  const manager = await users.findOneByOrFail({ email: 'friend@seerr.dev' });
  await users.update(manager.id, { permissions: Permission.MANAGE_USERS });
  const admin = await users.save(
    new User({
      email: 'second-admin@seerr.dev',
      username: 'second',
      avatar: '',
      permissions: Permission.ADMIN,
      userType: UserType.LOCAL,
    })
  );
  const regular = await users.save(
    new User({
      email: 'regular@seerr.dev',
      username: 'regular',
      avatar: '',
      permissions: Permission.REQUEST,
      userType: UserType.LOCAL,
    })
  );
  return { manager, admin, regular };
};

describe('changing permissions from the user list', () => {
  it('never lets someone raise their own', async () => {
    const { manager } = await people();
    const { agent } = await loginAs('friend@seerr.dev');
    const raised = Permission.MANAGE_USERS | Permission.MANAGE_SETTINGS;

    const one = await agent
      .put(`/user/${manager.id}`)
      .send({ permissions: raised });
    assert.equal(one.status, 403);

    const bulk = await agent
      .put('/user')
      .send({ ids: [String(manager.id)], permissions: raised });
    assert.equal(bulk.status, 200);
    assert.equal(await permissionsOf(manager.id), Permission.MANAGE_USERS);
  });

  it('never lets a user manager demote an admin', async () => {
    const { admin, regular } = await people();
    const { agent } = await loginAs('friend@seerr.dev');

    const one = await agent
      .put(`/user/${admin.id}`)
      .send({ permissions: Permission.REQUEST });
    assert.equal(one.status, 403);

    const bulk = await agent.put('/user').send({
      ids: [String(admin.id), String(regular.id), '1'],
      permissions: Permission.AUTO_APPROVE,
    });
    assert.equal(bulk.status, 200);
    assert.equal(await permissionsOf(admin.id), Permission.ADMIN);
    assert.equal(await permissionsOf(1), Permission.ADMIN);
    // Everyone else chosen is changed as before.
    assert.equal(await permissionsOf(regular.id), Permission.AUTO_APPROVE);
    assert.deepEqual(
      (bulk.body as { id: number }[]).map((user) => user.id),
      [regular.id]
    );
  });

  it('lets the owner change an admin, but never their own', async () => {
    const { admin } = await people();
    const { agent } = await loginAs('admin@seerr.dev');

    const one = await agent
      .put(`/user/${admin.id}`)
      .send({ username: 'renamed', permissions: Permission.MANAGE_USERS });
    assert.equal(one.status, 200);
    assert.equal(await permissionsOf(admin.id), Permission.MANAGE_USERS);

    const bulk = await agent
      .put('/user')
      .send({ ids: ['1', String(admin.id)], permissions: Permission.REQUEST });
    assert.equal(bulk.status, 200);
    assert.equal(await permissionsOf(admin.id), Permission.REQUEST);
    assert.equal(await permissionsOf(1), Permission.ADMIN);
  });

  it('answers without anyone’s email or settings', async () => {
    const { regular } = await people();
    const { agent } = await loginAs('admin@seerr.dev');

    const bulk = await agent
      .put('/user')
      .send({ ids: [String(regular.id)], permissions: Permission.REQUEST });
    assert.equal(bulk.status, 200);
    const [changed] = bulk.body as Record<string, unknown>[];
    assert.equal(changed.permissions, Permission.REQUEST);
    assert.equal(changed.email, undefined);
    assert.equal(changed.settings, undefined);
  });
});

describe('registering for push notifications', () => {
  const register = async (endpoint: unknown) => {
    const { agent } = await loginAs('friend@seerr.dev');
    return agent.post('/user/registerPushSubscription').send({
      endpoint,
      p256dh: 'p256dh-key',
      auth: `auth-${String(endpoint)}`,
      userAgent: 'test',
    });
  };

  it('accepts the browsers’ push services', async () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      assert.equal((await register(endpoint)).status, 204, endpoint);
    }
  });

  it('refuses any other address', async () => {
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://127.0.0.1/abc',
      'https://localhost:8080/abc',
      'https://192.168.1.10/abc',
      'https://router.lan/abc',
      'https://fcm.googleapis.com.evil.test/abc',
      'https://fcm.googleapis.com:8443/abc',
      'not a url',
      42,
    ]) {
      assert.equal((await register(endpoint)).status, 400, String(endpoint));
    }
    assert.equal(await getRepository(UserPushSubscription).count(), 0);
  });
});

describe('importing Plex users', () => {
  it('leaves a password account with a Plex friend’s email alone', async () => {
    const users = getRepository(User);
    const local = new User({
      email: 'taken@seerr.dev',
      username: 'local',
      avatar: '',
      permissions: Permission.REQUEST,
      userType: UserType.LOCAL,
    });
    await local.setPassword('test1234');
    await users.save(local);

    const getUsers = mock.method(PlexTvAPI.prototype, 'getUsers', async () => ({
      MediaContainer: {
        User: [
          {
            $: {
              id: '9001',
              title: 'friend',
              username: 'plexfriend',
              email: 'taken@seerr.dev',
              thumb: 'https://plex.tv/thumb',
            },
            Server: [],
          },
        ],
      },
    }));
    try {
      const { agent } = await loginAs('admin@seerr.dev');
      const res = await agent.post('/user/import-from-plex').send();
      assert.equal(res.status, 201);
      assert.equal(res.body.refreshedUsers, 0);
    } finally {
      getUsers.mock.restore();
    }

    const after = await users.findOneByOrFail({ id: local.id });
    assert.equal(after.userType, UserType.LOCAL);
    assert.equal(after.plexId, null);
    assert.equal(after.plexUsername, null);
  });
});

describe('a name to show for someone', () => {
  it('is never their email', async () => {
    const users = getRepository(User);
    const nameless = await users.save(
      new User({
        email: 'nameless@seerr.dev',
        avatar: '',
        permissions: Permission.REQUEST,
        userType: UserType.LOCAL,
      })
    );
    const { agent } = await loginAs('friend@seerr.dev');

    const res = await agent.get(`/user/${nameless.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.displayName, `User #${nameless.id}`);
    assert.doesNotMatch(JSON.stringify(res.body), /nameless@seerr\.dev/);
  });
});
