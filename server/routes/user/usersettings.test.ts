import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
import { DiscoverSliderType } from '@server/constants/discover';
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
      endpoint: 'https://push.test/device-1',
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
