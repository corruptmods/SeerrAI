import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { resetSignInMemoryForTests } from '@server/lib/signIn';
import { resetSiloDevicesForTests } from '@server/lib/siloAccounts';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import settingsRoutes from '@server/routes/settings';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import { createFakeSilo } from '@server/test/fakeSilo';
import express from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

/*
 * Silo accounts on Seerr AI users: linking by password or by a code approved
 * in Silo, unlinking, choosing "my profile", and Import Silo Users.
 */

setupTestDb();

const silo = createFakeSilo();
const app = express();
app.use(express.json());
app.use(
  session({ secret: 'test-secret', resave: false, saveUninitialized: false })
);
app.use(checkUser);
app.use('/auth', authRoutes);
app.use('/user', isAuthenticated(), userRoutes);
app.use('/settings', isAuthenticated(), settingsRoutes);
app.use(
  (
    err: { status?: number; message?: string },
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => res.status(err.status ?? 500).json({ message: err.message })
);

before(() => silo.start());
after(() => silo.stop());

const FRIEND = 2;

beforeEach(async () => {
  silo.reset();
  resetSiloDevicesForTests();
  resetSignInMemoryForTests();
  silo.accounts = [
    {
      id: 'acct-owner',
      username: 'harbour',
      password: 'lights',
      role: 'admin',
      profiles: [{ id: 'p-owner', name: 'Harbour', is_primary: true }],
    },
    {
      id: 'acct-friend',
      username: 'lantern',
      password: 'song',
      role: 'user',
      profiles: [
        { id: 'p-1', name: 'Lantern', is_primary: true },
        { id: 'p-2', name: 'Garden', is_primary: false, is_child: true },
      ],
    },
    {
      id: 'acct-new',
      username: 'glasswing',
      password: 'x',
      role: 'user',
    },
    {
      id: 'acct-off',
      username: 'static',
      password: 'x',
      role: 'user',
      enabled: false,
    },
  ];
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.main.localLogin = true;
  settings.plex.connected = true;
  settings.jellyfin.connected = false;
  settings.emby.connected = false;
  settings.silo = silo.settings();
  // The friend is a password account, so signing in asks no media server.
  await getRepository(User).update(FRIEND, {
    userType: UserType.LOCAL,
    plexId: null,
    siloUserId: null,
    siloUsername: null,
    siloProfileId: null,
    email: 'friend@seerr.dev',
  });
});

const signedIn = async (email: string) => {
  const agent = request.agent(app);
  const res = await agent
    .post('/auth/local')
    .send({ email, password: 'test1234' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return agent;
};

const friend = () => getRepository(User).findOneByOrFail({ id: FRIEND });

describe('linking a Silo account', () => {
  it('links by password, and a password account becomes a Silo account', async () => {
    const agent = await signedIn('friend@seerr.dev');
    const res = await agent
      .post(`/user/${FRIEND}/settings/linked-accounts/silo`)
      .send({ username: 'lantern', password: 'song' });
    assert.equal(res.status, 204, JSON.stringify(res.body));
    const user = await friend();
    assert.equal(user.siloUserId, 'acct-friend');
    assert.equal(user.siloUsername, 'lantern');
    assert.equal(user.siloProfileId, null);
    assert.equal(user.userType, UserType.SILO);
    assert.deepEqual(silo.openSessions(), []);

    // Nobody else can link it now.
    const owner = await signedIn('admin@seerr.dev');
    const again = await owner
      .post('/user/1/settings/linked-accounts/silo')
      .send({ username: 'lantern', password: 'song' });
    assert.equal(again.status, 422);
  });

  it('says plainly why Silo refused', async () => {
    const agent = await signedIn('friend@seerr.dev');
    let res = await agent
      .post(`/user/${FRIEND}/settings/linked-accounts/silo`)
      .send({ username: 'lantern', password: 'wrong' });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, ApiErrorCode.InvalidCredentials);
    silo.accounts[1].passwordChangeRequired = true;
    res = await agent
      .post(`/user/${FRIEND}/settings/linked-accounts/silo`)
      .send({ username: 'lantern', password: 'song' });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, ApiErrorCode.PasswordChangeRequired);
  });

  it('links with a code, keeping the profile it was approved as', async () => {
    const agent = await signedIn('friend@seerr.dev');
    const start = await agent.post(
      `/user/${FRIEND}/settings/linked-accounts/silo/device/start`
    );
    assert.equal(start.status, 200);
    // Someone else's session can't collect it.
    const owner = await signedIn('admin@seerr.dev');
    silo.approveDevice(start.body.userCode, 'acct-friend', 'p-2');
    let res = await owner
      .post('/user/1/settings/linked-accounts/silo/device/check')
      .send({ handle: start.body.handle });
    assert.deepEqual(res.body, { status: 'expired' });

    res = await agent
      .post(`/user/${FRIEND}/settings/linked-accounts/silo/device/check`)
      .send({ handle: start.body.handle });
    assert.deepEqual(res.body, { status: 'approved' });
    const user = await friend();
    assert.equal(user.siloUserId, 'acct-friend');
    assert.equal(user.siloProfileId, 'p-2');
  });

  it('unlinks, forgetting the chosen profile', async () => {
    await getRepository(User).update(FRIEND, {
      siloUserId: 'acct-friend',
      siloUsername: 'lantern',
      siloProfileId: 'p-2',
      userType: UserType.SILO,
    });
    const agent = await signedIn('friend@seerr.dev');
    const res = await agent.delete(
      `/user/${FRIEND}/settings/linked-accounts/silo`
    );
    assert.equal(res.status, 204);
    const user = await friend();
    assert.equal(user.siloUserId, null);
    assert.equal(user.siloProfileId, null);
    assert.equal(user.userType, UserType.LOCAL);
  });
});

describe('choosing my Silo profile', () => {
  beforeEach(() =>
    getRepository(User).update(FRIEND, {
      siloUserId: 'acct-friend',
      siloUsername: 'lantern',
      userType: UserType.SILO,
    })
  );

  it('lists the account’s profiles and keeps the one chosen, or all', async () => {
    const agent = await signedIn('friend@seerr.dev');
    let res = await agent.get(
      `/user/${FRIEND}/settings/linked-accounts/silo/profiles`
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      profileId: null,
      profiles: [
        { id: 'p-1', name: 'Lantern', primary: true, child: false },
        { id: 'p-2', name: 'Garden', primary: false, child: true },
      ],
    });
    res = await agent
      .put(`/user/${FRIEND}/settings/linked-accounts/silo/profile`)
      .send({ profileId: 'p-2' });
    assert.equal(res.status, 200);
    assert.equal((await friend()).siloProfileId, 'p-2');

    res = await agent
      .put(`/user/${FRIEND}/settings/linked-accounts/silo/profile`)
      .send({ profileId: 'p-owner' });
    assert.equal(res.status, 400, 'not on their account');
    assert.equal((await friend()).siloProfileId, 'p-2');

    res = await agent
      .put(`/user/${FRIEND}/settings/linked-accounts/silo/profile`)
      .send({ profileId: null });
    assert.equal(res.status, 200);
    assert.equal((await friend()).siloProfileId, null);
  });

  it('is only for themselves and user managers', async () => {
    await getRepository(User).update(FRIEND, { permissions: 32 });
    const other = await getRepository(User).save(
      new User({
        email: 'harbour@example.invalid',
        userType: UserType.LOCAL,
        permissions: 32,
        avatar: '',
      })
    );
    await other.setPassword('test1234');
    await getRepository(User).save(other);
    const agent = await signedIn('harbour@example.invalid');
    const res = await agent.get(
      `/user/${FRIEND}/settings/linked-accounts/silo/profiles`
    );
    assert.equal(res.status, 403);
  });
});

describe('importing Silo users', () => {
  it('lists switched-on accounts not yet imported, and imports them', async () => {
    await getRepository(User).update(FRIEND, {
      siloUserId: 'acct-friend',
      siloUsername: 'old-name',
      userType: UserType.SILO,
    });
    // Another account already has this name as its email.
    await getRepository(User).update(1, { email: 'harbour' });
    const owner = await signedIn('harbour');
    let res = await owner.get('/settings/silo/users');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((u: { id: string }) => u.id),
      ['acct-new', 'acct-owner']
    );

    res = await owner.post('/user/import-from-silo').send({});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(
      res.body.createdUsers.map(
        (u: { siloUsername: string }) => u.siloUsername
      ),
      ['glasswing']
    );
    assert.equal(res.body.refreshedUsers, 1);
    assert.deepEqual(res.body.skippedUsers, [
      {
        id: 'acct-owner',
        name: 'harbour',
        reason: ApiErrorCode.ExistingAccount,
      },
    ]);
    assert.equal((await friend()).siloUsername, 'lantern', 'refreshed');
    assert.equal(
      await getRepository(User).countBy({ siloUserId: 'acct-off' }),
      0,
      'switched-off accounts are left out'
    );
    const created = await getRepository(User).findOneByOrFail({
      siloUserId: 'acct-new',
    });
    assert.equal(created.userType, UserType.SILO);
    assert.equal(created.avatar, '/avatarproxy/silo/acct-new');
  });

  it('imports only those chosen', async () => {
    const owner = await signedIn('admin@seerr.dev');
    const res = await owner
      .post('/user/import-from-silo')
      .send({ siloUserIds: ['acct-new'] });
    assert.equal(res.status, 201);
    assert.equal(res.body.createdUsers.length, 1);
    assert.equal(
      await getRepository(User).countBy({ siloUserId: 'acct-owner' }),
      0
    );
  });
});
