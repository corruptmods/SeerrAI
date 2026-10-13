import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import { DiscoverSliderType } from '@server/constants/discover';
import { MAX_DISCOVER_NETWORKS } from '@server/constants/discoverNetworks';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import { User } from '@server/entity/User';
import UserPasskey from '@server/entity/UserPasskey';
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

const defaultAuthenticateResponse = {
  User: {
    Id: 'jf-link-user-001',
    Name: 'linkeduser',
    ServerId: 'server-1',
    Policy: { IsAdministrator: false },
  },
  AccessToken: 'fake-qc-access-token',
};

const authenticateQCMock = mock.method(
  JellyfinAPI.prototype,
  'authenticateQuickConnect',
  async () => ({ ...defaultAuthenticateResponse })
);

// Plex accounts signing in with a password are checked against the owner's
// share list; everyone here is on it.
mock.method(PlexTvAPI.prototype, 'checkUserAccess', async () => true);

let app: Express;

function createApp() {
  const app = express();
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(async () => {
  app = createApp();
});

setupTestDb();

function configureJellyfin() {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.JELLYFIN;
  settings.jellyfin.ip = 'localhost';
  settings.jellyfin.port = 8096;
  settings.jellyfin.useSsl = false;
  settings.jellyfin.urlBase = '';
}

async function loginAs(email: string, password: string) {
  const settings = getSettings();
  settings.main.localLogin = true;

  const agent = request.agent(app);
  const res = await agent.post('/auth/local').send({ email, password });

  assert.strictEqual(res.status, 200);
  return { agent, userId: res.body.id as number };
}

describe('POST /user/:id/settings/linked-accounts/jellyfin/quickconnect', () => {
  beforeEach(() => {
    authenticateQCMock.mock.resetCalls();
    authenticateQCMock.mock.mockImplementation(async () => ({
      ...defaultAuthenticateResponse,
    }));
    configureJellyfin();
  });

  it('links the account when the media server is Jellyfin', async () => {
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');

    const res = await agent
      .post(`/user/${userId}/settings/linked-accounts/jellyfin/quickconnect`)
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 204);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 1);

    const user = await getRepository(User).findOneOrFail({
      where: { id: userId },
    });
    assert.strictEqual(user.jellyfinUserId, 'jf-link-user-001');
    assert.strictEqual(user.userType, UserType.JELLYFIN);
  });

  it('returns 403 when the media server is Emby', async () => {
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    getSettings().main.mediaServerType = MediaServerType.EMBY;

    const res = await agent
      .post(`/user/${userId}/settings/linked-accounts/jellyfin/quickconnect`)
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 0);

    const user = await getRepository(User).findOneOrFail({
      where: { id: userId },
    });
    assert.strictEqual(user.jellyfinUserId, null);
  });
});

describe('the owner and shared devices', () => {
  it("keeps the owner's feature switches the owner's", async () => {
    const users = getRepository(User);
    const friend = await users.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    friend.permissions = Permission.MANAGE_USERS;
    await users.save(friend);

    const { agent } = await loginAs('friend@seerr.dev', 'test1234');
    const owner = await agent
      .post('/user/1/settings/features')
      .send({ disabled: ['releaseCalendar'] });
    assert.strictEqual(owner.status, 403);

    const own = await agent
      .post(`/user/${friend.id}/settings/features`)
      .send({ disabled: ['releaseCalendar'] });
    assert.strictEqual(own.status, 200);
  });

  it('lets a device belong to one person at a time for push', async () => {
    const device = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
      p256dh: 'key',
      auth: 'secret',
      userAgent: 'test',
    };
    const first = await loginAs('friend@seerr.dev', 'test1234');
    assert.strictEqual(
      (await first.agent.post('/user/registerPushSubscription').send(device))
        .status,
      204
    );

    // The same device, now registered by someone else.
    const second = await loginAs('admin@seerr.dev', 'test1234');
    assert.strictEqual(
      (
        await second.agent
          .post('/user/registerPushSubscription')
          .send({ ...device, auth: 'other-secret' })
      ).status,
      204
    );

    const owners = await getRepository(UserPushSubscription).find({
      relations: { user: true },
      where: { endpoint: device.endpoint },
    });
    assert.deepStrictEqual(
      owners.map((o) => o.user.id),
      [second.userId]
    );
  });
});

describe("removing someone else's passkey", () => {
  const passkeyFor = (user: User, name: string) =>
    getRepository(UserPasskey).save(
      new UserPasskey({
        user,
        credentialId: `cred-${name}`,
        publicKey: 'secret-public-key',
        counter: '0',
        backedUp: false,
        name,
      })
    );

  const people = async () => {
    const users = getRepository(User);
    return {
      owner: await users.findOneOrFail({ where: { id: 1 } }),
      friend: await users.findOneOrFail({
        where: { email: 'friend@seerr.dev' },
      }),
    };
  };

  it('lets someone who manages users see and remove a lost device', async () => {
    const { friend } = await people();
    const lost = await passkeyFor(friend, 'Lost phone');
    const kept = await passkeyFor(friend, 'Laptop');

    const { agent } = await loginAs('admin@seerr.dev', 'test1234');
    const list = await agent.get(`/user/${friend.id}/settings/passkeys`);
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(
      list.body.map((p: { name: string }) => p.name),
      ['Lost phone', 'Laptop']
    );
    assert.ok(!JSON.stringify(list.body).includes('secret-public-key'));

    const removed = await agent.delete(
      `/user/${friend.id}/settings/passkeys/${lost.id}`
    );
    assert.strictEqual(removed.status, 204);
    const left = await getRepository(UserPasskey).find({
      where: { user: { id: friend.id } },
    });
    assert.deepStrictEqual(
      left.map((p) => p.id),
      [kept.id]
    );
  });

  it("only removes a passkey through its own person's page", async () => {
    const { owner, friend } = await people();
    const ownersKey = await passkeyFor(owner, 'Owner phone');

    const { agent } = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(
      `/user/${friend.id}/settings/passkeys/${ownersKey.id}`
    );
    assert.strictEqual(res.status, 404);
    assert.ok(await getRepository(UserPasskey).findOneBy({ id: ownersKey.id }));
  });

  it("keeps the owner's passkeys the owner's, even from user managers", async () => {
    const { owner, friend } = await people();
    const ownersKey = await passkeyFor(owner, 'Owner phone');
    friend.permissions = Permission.MANAGE_USERS;
    await getRepository(User).save(friend);

    const { agent } = await loginAs('friend@seerr.dev', 'test1234');
    assert.strictEqual(
      (await agent.get('/user/1/settings/passkeys')).status,
      403
    );
    assert.strictEqual(
      (await agent.delete(`/user/1/settings/passkeys/${ownersKey.id}`)).status,
      403
    );
    assert.ok(await getRepository(UserPasskey).findOneBy({ id: ownersKey.id }));
  });

  it('is refused to everyone else', async () => {
    const { owner } = await people();
    await passkeyFor(owner, 'Owner phone');

    const { agent } = await loginAs('friend@seerr.dev', 'test1234');
    assert.strictEqual(
      (await agent.get('/user/1/settings/passkeys')).status,
      403
    );
  });
});

describe('the home page rows a person hides', () => {
  it('keeps them per person, drops ids that are not rows, and shows them on /auth/me', async () => {
    await DiscoverSlider.bootstrapSliders();
    const rows = await getRepository(DiscoverSlider).find({
      order: { order: 'ASC' },
    });
    const deletingSoon = rows.find(
      (r) => r.type === DiscoverSliderType.DELETING_SOON
    )!;
    const trending = rows.find((r) => r.type === DiscoverSliderType.TRENDING)!;

    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    const saved = await agent
      .post(`/user/${userId}/settings/discover`)
      .send({ hidden: [deletingSoon.id, trending.id, 99999, trending.id] });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.body.hidden, [deletingSoon.id, trending.id]);

    const me = await agent.get('/auth/me');
    assert.deepStrictEqual(me.body.settings.hiddenSliders, [
      deletingSoon.id,
      trending.id,
    ]);
    assert.deepStrictEqual(
      (await agent.get(`/user/${userId}/settings/discover`)).body.hidden,
      [deletingSoon.id, trending.id]
    );

    // Not someone else's, and not nonsense.
    assert.strictEqual(
      (await agent.post('/user/1/settings/discover').send({ hidden: [] }))
        .status,
      403
    );
    assert.strictEqual(
      (
        await agent
          .post(`/user/${userId}/settings/discover`)
          .send({ hidden: ['x'] })
      ).status,
      400
    );
  });
});

describe('a person’s own Networks row', () => {
  const list = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      name: `Network ${i + 1}`,
      logoPath: '/logo.png',
    }));

  it('is theirs alone, checked, and the usual list until they choose', async () => {
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    // The usual list to begin with.
    assert.strictEqual(
      (await agent.get(`/user/${userId}/settings/discover`)).body.networks,
      null
    );

    // Their own: trimmed, a repeat dropped, anything extra left out.
    const saved = await agent.post(`/user/${userId}/settings/discover`).send({
      networks: JSON.stringify([
        { id: 2697, name: ' Acorn TV ', logoPath: '/acorn.png', x: 1 },
        { id: 2697, name: 'Again', logoPath: '/again.png' },
      ]),
    });
    assert.strictEqual(saved.status, 200);
    const mine = JSON.stringify([
      { id: 2697, name: 'Acorn TV', logoPath: '/acorn.png' },
    ]);
    assert.strictEqual(saved.body.networks, mine);
    assert.strictEqual(
      (await agent.get('/auth/me')).body.settings.discoverNetworks,
      mine
    );

    // Hiding rows leaves the list alone, and the list leaves hidden rows.
    await agent.post(`/user/${userId}/settings/discover`).send({ hidden: [] });
    assert.strictEqual(
      (await agent.get(`/user/${userId}/settings/discover`)).body.networks,
      mine
    );

    // Refused lists change nothing.
    const tooMany = await agent
      .post(`/user/${userId}/settings/discover`)
      .send({ networks: JSON.stringify(list(MAX_DISCOVER_NETWORKS + 1)) });
    assert.strictEqual(tooMany.status, 400);
    assert.strictEqual(tooMany.body.message, ApiErrorCode.TooManyNetworks);
    const bad = await agent.post(`/user/${userId}/settings/discover`).send({
      networks: JSON.stringify([
        { id: 1, name: 'N', logoPath: 'https://elsewhere/x.png' },
      ]),
    });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.message, ApiErrorCode.InvalidNetworkList);
    assert.strictEqual(
      (await agent.get(`/user/${userId}/settings/discover`)).body.networks,
      mine
    );

    // None at all is kept as none; null is the usual list again.
    await agent
      .post(`/user/${userId}/settings/discover`)
      .send({ networks: '[]' });
    assert.strictEqual(
      (await agent.get('/auth/me')).body.settings.discoverNetworks,
      '[]'
    );
    await agent
      .post(`/user/${userId}/settings/discover`)
      .send({ networks: null });
    assert.strictEqual(
      (await agent.get('/auth/me')).body.settings.discoverNetworks,
      null
    );

    // Not someone else's, and not an empty request.
    assert.strictEqual(
      (await agent.post('/user/1/settings/discover').send({ networks: mine }))
        .status,
      403
    );
    assert.strictEqual(
      (await agent.post(`/user/${userId}/settings/discover`).send({})).status,
      400
    );
  });
});

describe('a person’s Trakt username', () => {
  it('is kept, checked, shown on /auth/me, and cleared when blank', async () => {
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    const save = (traktUsername: string) =>
      agent
        .post(`/user/${userId}/settings/main`)
        .send({ username: 'friend', traktUsername });

    const saved = await save(' some.one_2 ');
    assert.strictEqual(saved.status, 200);
    assert.strictEqual(saved.body.traktUsername, 'some.one_2');
    assert.strictEqual(
      (await agent.get(`/user/${userId}/settings/main`)).body.traktUsername,
      'some.one_2'
    );
    assert.strictEqual(
      (await agent.get('/auth/me')).body.settings.traktUsername,
      'some.one_2'
    );

    const bad = await save('not a name!');
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(
      (await agent.get(`/user/${userId}/settings/main`)).body.traktUsername,
      'some.one_2'
    );

    assert.strictEqual((await save('')).body.traktUsername, null);
  });
});

describe('settings an admin saves for someone else', () => {
  it('belong to that person, even when they had none yet', async () => {
    const users = getRepository(User);
    const fresh = await users.save(
      new User({
        email: 'fresh@seerr.dev',
        username: 'fresh',
        permissions: Permission.REQUEST,
        avatar: '',
        userType: UserType.LOCAL,
      })
    );
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');

    const saved = await agent
      .post(`/user/${fresh.id}/settings/main`)
      .send({ username: 'fresh', locale: 'de', traktUsername: 'fresh-one' });
    assert.strictEqual(saved.status, 200);

    const reloaded = await users.findOneOrFail({
      where: { id: fresh.id },
      relations: { settings: true },
    });
    assert.strictEqual(reloaded.settings?.locale, 'de');
    assert.strictEqual(reloaded.settings?.traktUsername, 'fresh-one');

    const admin = await users.findOneOrFail({
      where: { id: 1 },
      relations: { settings: true },
    });
    assert.notStrictEqual(admin.settings?.traktUsername, 'fresh-one');
  });
});

/*
 * Someone who manages users, but is not an admin, and an admin who is not
 * the owner: only the owner changes an admin's account.
 */
describe("another admin's account", () => {
  const people = async () => {
    const users = getRepository(User);
    const friend = await users.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    await users.update(friend.id, {
      permissions: Permission.MANAGE_USERS,
      userType: UserType.LOCAL,
    });
    const admin = new User({
      email: 'second-admin@seerr.dev',
      username: 'second',
      avatar: '',
      permissions: Permission.ADMIN,
      userType: UserType.PLEX,
      plexId: 7000,
    });
    await admin.setPassword('test1234');
    await users.save(admin);
    const regular = await users.save(
      new User({
        email: 'regular@seerr.dev',
        username: 'regular',
        avatar: '',
        permissions: Permission.REQUEST,
        userType: UserType.LOCAL,
      })
    );
    return { friend, admin, regular };
  };

  const emailOf = async (id: number) =>
    (await getRepository(User).findOneByOrFail({ id })).email;

  it('cannot have its email changed by a user manager', async () => {
    const { admin, regular } = await people();
    const { agent } = await loginAs('friend@seerr.dev', 'test1234');

    const res = await agent
      .post(`/user/${admin.id}/settings/main`)
      .send({ username: 'second', email: 'taken-over@evil.test' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(await emailOf(admin.id), 'second-admin@seerr.dev');

    // Everyone else's they still manage.
    const ok = await agent
      .post(`/user/${regular.id}/settings/main`)
      .send({ username: 'regular', email: 'regular2@seerr.dev' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(await emailOf(regular.id), 'regular2@seerr.dev');
  });

  it('cannot have its notifications or Plex sign-in changed by a user manager', async () => {
    getSettings().main.mediaServerType = MediaServerType.PLEX;
    const { admin } = await people();
    const { agent } = await loginAs('friend@seerr.dev', 'test1234');

    const notifications = await agent
      .post(`/user/${admin.id}/settings/notifications`)
      .send({ pgpKey: 'not theirs', notificationTypes: {} });
    assert.strictEqual(notifications.status, 403);

    const unlink = await agent.delete(
      `/user/${admin.id}/settings/linked-accounts/plex`
    );
    assert.strictEqual(unlink.status, 403);
    const after = await getRepository(User).findOneByOrFail({ id: admin.id });
    assert.strictEqual(after.plexId, 7000);
    assert.strictEqual(after.userType, UserType.PLEX);
  });

  it('cannot be demoted by a user manager', async () => {
    const { admin } = await people();
    const { agent } = await loginAs('friend@seerr.dev', 'test1234');

    const res = await agent
      .post(`/user/${admin.id}/settings/permissions`)
      .send({ permissions: Permission.REQUEST });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(
      (await getRepository(User).findOneByOrFail({ id: admin.id })).permissions,
      Permission.ADMIN
    );
  });

  it('is changed by its owner and by the server owner', async () => {
    const { admin } = await people();
    // A Plex account's email is Plex's; a password account's is its own.
    await getRepository(User).update(admin.id, { userType: UserType.LOCAL });
    const own = await loginAs('second-admin@seerr.dev', 'test1234');
    const mine = await own.agent
      .post(`/user/${admin.id}/settings/main`)
      .send({ username: 'second', email: 'second-new@seerr.dev' });
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(await emailOf(admin.id), 'second-new@seerr.dev');

    const owner = await loginAs('admin@seerr.dev', 'test1234');
    const byOwner = await owner.agent
      .post(`/user/${admin.id}/settings/main`)
      .send({ username: 'second', email: 'second-again@seerr.dev' });
    assert.strictEqual(byOwner.status, 200);
    assert.strictEqual(await emailOf(admin.id), 'second-again@seerr.dev');
  });
});

describe('changing your own password', () => {
  it('takes the current one when you have one', async () => {
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    const change = (body: object) =>
      agent.post(`/user/${userId}/settings/password`).send(body);

    assert.strictEqual(
      (await change({ newPassword: 'new-password' })).status,
      403
    );
    assert.strictEqual(
      (await change({ currentPassword: 'wrong', newPassword: 'new-password' }))
        .status,
      403
    );
    assert.strictEqual(
      (
        await change({
          currentPassword: 'test1234',
          newPassword: 'new-password',
        })
      ).status,
      204
    );
    await loginAs('friend@seerr.dev', 'new-password');
  });

  it('sets a first one without asking for an old one', async () => {
    const users = getRepository(User);
    const friend = await users.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    // Signed in, then the password taken away (a Plex user never had one).
    const { agent } = await loginAs('friend@seerr.dev', 'test1234');
    await users.update(friend.id, { password: null as unknown as string });

    const res = await agent
      .post(`/user/${friend.id}/settings/password`)
      .send({ newPassword: 'first-password' });
    assert.strictEqual(res.status, 204);
    await loginAs('friend@seerr.dev', 'first-password');
  });
});

describe('a Trakt username made of dots', () => {
  it('is refused', async () => {
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    for (const name of ['.', '..', '...']) {
      const res = await agent
        .post(`/user/${userId}/settings/main`)
        .send({ username: 'friend', traktUsername: name });
      assert.strictEqual(res.status, 400, name);
    }
    const ok = await agent
      .post(`/user/${userId}/settings/main`)
      .send({ username: 'friend', traktUsername: '.a.' });
    assert.strictEqual(ok.status, 200);
  });
});
