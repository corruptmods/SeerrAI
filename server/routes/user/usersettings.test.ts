import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import { DiscoverSliderType } from '@server/constants/discover';
import { MAX_DISCOVER_NETWORKS } from '@server/constants/discoverNetworks';
import { ApiErrorCode } from '@server/constants/error';
import { NAV_ITEMS } from '@server/constants/navigation';
import type { MediaServerKind } from '@server/constants/server';
import {
  MEDIA_SERVER_KINDS,
  MediaServerType,
  typeOfKind,
} from '@server/constants/server';
import { SERVER_THEME_DEFAULTS } from '@server/constants/theme';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import { User } from '@server/entity/User';
import UserApiKey from '@server/entity/UserApiKey';
import UserPasskey from '@server/entity/UserPasskey';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { UserSettings } from '@server/entity/UserSettings';
import PreparedEmail from '@server/lib/email';
import { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { makeKey } from '@server/lib/personalApiKeys';
import type { LidarrSettings, RadarrSettings } from '@server/lib/settings';
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

// Plex accounts (password or linked) are checked against the owner's share
// list; everyone is on it unless a test says otherwise.
let plexShared = true;
mock.method(PlexTvAPI.prototype, 'checkUserAccess', async () => plexShared);

/** The account plex.tv returns when a user links Plex. */
let plexAccount = { id: 5000, email: 'friend@seerr.dev' };
mock.method(PlexTvAPI.prototype, 'getUser', async () => ({
  ...plexAccount,
  uuid: 'uuid',
  username: 'plexname',
  title: 'plexname',
  thumb: 'https://plex.tv/thumb',
  authToken: 'plex-token',
}));

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
    // A password account becomes a Jellyfin account.
    await getRepository(User).update(
      { email: 'friend@seerr.dev' },
      { userType: UserType.LOCAL, plexId: null }
    );
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

    // The same device, now registered by another user.
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

    // Refused for another user, and for invalid input.
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
    // Starts with the default list.
    assert.strictEqual(
      (await agent.get(`/user/${userId}/settings/discover`)).body.networks,
      null
    );

    // Their own: trimmed, duplicates and extra fields dropped.
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

    // Hidden rows and the network list are saved independently.
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

    // An empty list stays empty; null restores the default.
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

    // Refused for another user, and for an empty request.
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

describe('a person’s own sidebar', () => {
  it('is the usual one until they arrange it', async () => {
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.get(`/user/${userId}/settings/sidebar`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { order: [], hidden: [] });
    const me = (await agent.get('/auth/me')).body;
    assert.deepStrictEqual(me.settings?.sidebarOrder ?? [], []);
    assert.deepStrictEqual(me.settings?.sidebarHidden ?? [], []);
  });

  it('keeps their order and hidden items, cleaned, for them alone', async () => {
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    const saved = await agent.post(`/user/${userId}/settings/sidebar`).send({
      order: ['lists', 'discover', 'books', 'lists'],
      // Discover and Settings can't be hidden; unknown names are dropped.
      hidden: ['issues', 'settings', 'discover', 'books', 'issues'],
    });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.body, {
      order: ['lists', 'discover'],
      hidden: ['issues'],
    });

    const me = (await agent.get('/auth/me')).body;
    assert.deepStrictEqual(me.settings.sidebarOrder, ['lists', 'discover']);
    assert.deepStrictEqual(me.settings.sidebarHidden, ['issues']);
    assert.deepStrictEqual(
      (await agent.get(`/user/${userId}/settings/sidebar`)).body,
      saved.body
    );

    // Other users are unaffected.
    const admin = await loginAs('admin@seerr.dev', 'test1234');
    assert.deepStrictEqual(
      (await admin.agent.get('/user/1/settings/sidebar')).body,
      { order: [], hidden: [] }
    );
    const adminMe = (await admin.agent.get('/auth/me')).body;
    assert.deepStrictEqual(adminMe.settings?.sidebarOrder ?? [], []);
    assert.deepStrictEqual(adminMe.settings?.sidebarHidden ?? [], []);
  });

  it('changes only what is sent, and keeps the default order as none', async () => {
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    await agent
      .post(`/user/${userId}/settings/sidebar`)
      .send({ order: ['requests', 'discover'], hidden: ['blocklist'] });

    const onlyHidden = await agent
      .post(`/user/${userId}/settings/sidebar`)
      .send({ hidden: ['calendar'] });
    assert.deepStrictEqual(onlyHidden.body, {
      order: ['requests', 'discover'],
      hidden: ['calendar'],
    });

    // The full default order is stored as no order, so items added later
    // take their default place.
    const reset = await agent
      .post(`/user/${userId}/settings/sidebar`)
      .send({ order: [...NAV_ITEMS], hidden: [] });
    assert.deepStrictEqual(reset.body, { order: [], hidden: [] });
    const stored = await getRepository(UserSettings).findOneOrFail({
      where: { user: { id: userId } },
    });
    assert.deepStrictEqual(stored.sidebarOrder, []);
    assert.deepStrictEqual(stored.sidebarHidden, []);
  });

  it('refuses someone else’s, and anything that is not a list of names', async () => {
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    assert.strictEqual(
      (await agent.post('/user/1/settings/sidebar').send({ order: [] })).status,
      403
    );
    assert.strictEqual(
      (await agent.get('/user/1/settings/sidebar')).status,
      403
    );
    for (const body of [
      {},
      { order: 'lists' },
      { hidden: [1] },
      { order: ['lists'], hidden: null },
    ]) {
      assert.strictEqual(
        (await agent.post(`/user/${userId}/settings/sidebar`).send(body))
          .status,
        400,
        JSON.stringify(body)
      );
    }
  });
});

describe('a person’s own look', () => {
  beforeEach(() => {
    getSettings().appearance.default = { ...SERVER_THEME_DEFAULTS };
  });

  const look = {
    mode: 'light',
    accent: 'custom',
    customAccent: '#0EA5E9',
    background: 'black',
    spacing: 'compact',
    corners: 'square',
    blur: false,
    solidPanels: true,
    seasonal: false,
  };

  it('is the server’s default until they choose one', async () => {
    getSettings().appearance.default = {
      mode: 'auto',
      accent: 'teal',
      background: 'slate',
    };
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.get(`/user/${userId}/settings/appearance`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      appearance: null,
      serverDefault: { mode: 'auto', accent: 'teal', background: 'slate' },
    });
    const me = (await agent.get('/auth/me')).body;
    assert.strictEqual(me.settings?.appearance ?? null, null);
  });

  it('keeps their choice, tidied, for them alone, until they go back to the default', async () => {
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    const saved = await agent
      .post(`/user/${userId}/settings/appearance`)
      .send({ appearance: look });
    assert.strictEqual(saved.status, 200);
    const kept = { ...look, customAccent: '#0ea5e9' };
    assert.deepStrictEqual(saved.body.appearance, kept);
    assert.deepStrictEqual(
      (await agent.get(`/user/${userId}/settings/appearance`)).body.appearance,
      kept
    );
    // Pages read it from the signed-in user.
    assert.deepStrictEqual(
      (await agent.get('/auth/me')).body.settings.appearance,
      kept
    );

    // Other users are unaffected.
    const admin = await loginAs('admin@seerr.dev', 'test1234');
    assert.strictEqual(
      (await admin.agent.get('/user/1/settings/appearance')).body.appearance,
      null
    );

    const reset = await agent
      .post(`/user/${userId}/settings/appearance`)
      .send({ appearance: null });
    assert.strictEqual(reset.status, 200);
    assert.strictEqual(reset.body.appearance, null);
    const stored = await getRepository(UserSettings).findOneOrFail({
      where: { user: { id: userId } },
    });
    assert.strictEqual(stored.appearance, null);
  });

  it('refuses someone else’s, and anything that is not a look', async () => {
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    assert.strictEqual(
      (
        await agent
          .post('/user/1/settings/appearance')
          .send({ appearance: null })
      ).status,
      403
    );
    assert.strictEqual(
      (await agent.get('/user/1/settings/appearance')).status,
      403
    );
    for (const body of [
      {},
      { appearance: 'dark' },
      { appearance: { ...look, mode: 'dim' } },
      { appearance: { ...look, customAccent: 'url(evil)' } },
      { appearance: { ...look, css: 'body{}' } },
    ]) {
      assert.strictEqual(
        (await agent.post(`/user/${userId}/settings/appearance`).send(body))
          .status,
        400,
        JSON.stringify(body)
      );
    }
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

describe('a person’s default quality profiles', () => {
  it('are kept per server, checked, and left alone when not sent', async () => {
    const settings = getSettings();
    const saved = { radarr: settings.radarr, lidarr: settings.lidarr };
    settings.radarr = [{ id: 0, name: 'Radarr' } as RadarrSettings];
    settings.lidarr = [{ id: 2, name: 'Lidarr' } as LidarrSettings];
    try {
      const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
      const res = await agent.post(`/user/${userId}/settings/main`).send({
        username: 'friend',
        defaultProfiles: [
          { service: 'radarr', serverId: 0, profileId: 4 },
          { service: 'radarr', serverId: 0, anime: true, profileId: 9 },
          { service: 'radarr', serverId: 5, profileId: 4 },
          { service: 'sonarr', serverId: 0, profileId: 4 },
          { service: 'lidarr', serverId: 2, profileId: 3 },
        ],
      });
      assert.strictEqual(res.status, 200);
      const expected = [
        { service: 'radarr', serverId: 0, profileId: 4 },
        { service: 'radarr', serverId: 0, anime: true, profileId: 9 },
        { service: 'lidarr', serverId: 2, profileId: 3 },
      ];
      assert.deepStrictEqual(res.body.defaultProfiles, expected);

      await agent
        .post(`/user/${userId}/settings/main`)
        .send({ username: 'friend', locale: 'en' });
      assert.deepStrictEqual(
        (await agent.get(`/user/${userId}/settings/main`)).body.defaultProfiles,
        expected
      );

      await agent
        .post(`/user/${userId}/settings/main`)
        .send({ username: 'friend', defaultProfiles: [] });
      assert.deepStrictEqual(
        (await agent.get(`/user/${userId}/settings/main`)).body.defaultProfiles,
        []
      );
    } finally {
      settings.radarr = saved.radarr;
      settings.lidarr = saved.lidarr;
    }
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
 * A non-admin user manager and a non-owner admin: only the owner changes an
 * admin's account.
 */
describe('notification settings an admin saves for someone else', () => {
  it('belong to that person, even when they had none yet', async () => {
    const users = getRepository(User);
    const fresh = await users.save(
      new User({
        email: 'fresh-notify@seerr.dev',
        username: 'fresh-notify',
        permissions: Permission.REQUEST,
        avatar: '',
        userType: UserType.LOCAL,
      })
    );
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');

    const saved = await agent
      .post(`/user/${fresh.id}/settings/notifications`)
      .send({ pgpKey: 'harbour-lights-key', notificationTypes: {} });
    assert.strictEqual(saved.status, 200);

    const settings = await getRepository(UserSettings).findOneOrFail({
      where: { pgpKey: 'harbour-lights-key' },
      relations: { user: true },
    });
    assert.strictEqual(settings.user.id, fresh.id);
  });
});

describe('the Discord bot note on Discord settings', () => {
  it('tells managers, only while the bot is on, that their ID approves', async () => {
    const bot = getSettings().notifications.agents.discordBot;
    const before = structuredClone(bot);
    try {
      const { agent } = await loginAs('admin@seerr.dev', 'test1234');
      const off = await agent.get('/user/1/settings/notifications');
      assert.strictEqual(off.body.discordBotApprovals, false);

      bot.enabled = true;
      bot.options.channelId = '200000000000000002';
      const on = await agent.get('/user/1/settings/notifications');
      assert.strictEqual(on.body.discordBotApprovals, true);

      // friend@seerr.dev can only request.
      const friend = await agent.get('/user/2/settings/notifications');
      assert.strictEqual(friend.body.discordBotApprovals, false);
    } finally {
      Object.assign(bot, before);
    }
  });
});

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

    // They still manage everyone else.
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

  it('keeps its notification settings from user managers', async () => {
    const { admin, regular } = await people();
    const users = getRepository(User);
    for (const id of [1, admin.id, regular.id]) {
      const user = await users.findOneOrFail({
        where: { id },
        relations: { settings: true },
      });
      user.settings = new UserSettings({
        ...user.settings,
        user,
        pushbulletAccessToken: `token-${id}`,
      });
      await users.save(user);
    }
    const { agent } = await loginAs('friend@seerr.dev', 'test1234');

    for (const id of [1, admin.id]) {
      const res = await agent.get(`/user/${id}/settings/notifications`);
      assert.strictEqual(res.status, 403);
      assert.doesNotMatch(JSON.stringify(res.body), /token-/);
    }
    const theirs = await agent.get(
      `/user/${regular.id}/settings/notifications`
    );
    assert.strictEqual(theirs.status, 200);
    assert.strictEqual(
      theirs.body.pushbulletAccessToken,
      `token-${regular.id}`
    );

    const owner = await loginAs('admin@seerr.dev', 'test1234');
    const byOwner = await owner.agent.get(
      `/user/${admin.id}/settings/notifications`
    );
    assert.strictEqual(byOwner.status, 200);
    assert.strictEqual(byOwner.body.pushbulletAccessToken, `token-${admin.id}`);
  });

  it('keeps its display preferences from user managers', async () => {
    const { admin, regular } = await people();
    const { agent } = await loginAs('friend@seerr.dev', 'test1234');
    const changes: [string, object][] = [
      ['features', { disabled: [] }],
      ['discover', { hidden: [] }],
      ['appearance', { appearance: null }],
      ['sidebar', { hidden: [] }],
    ];
    for (const [page, body] of changes) {
      const theirs = await agent
        .post(`/user/${admin.id}/settings/${page}`)
        .send(body);
      assert.strictEqual(theirs.status, 403, page);
      const others = await agent
        .post(`/user/${regular.id}/settings/${page}`)
        .send(body);
      assert.strictEqual(others.status, 200, page);
    }
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
    // A Plex account's email comes from Plex; a password account's is its own.
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
    // Signed in, then the password removed (as for a Plex user).
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

/*
 * Linked accounts with several media servers, the first named primary. Each
 * test leaves only the primary connected.
 */
describe('linked accounts with several media servers', () => {
  const connectServers = (...kinds: MediaServerKind[]) => {
    const settings = getSettings();
    settings.main.mediaServerType = typeOfKind(kinds[0]);
    settings.main.localLogin = true;
    settings.plex.machineId = 'machine-1';
    for (const kind of MEDIA_SERVER_KINDS) {
      settings[kind].connected = kinds.includes(kind);
      settings[kind].signIn = true;
    }
    settings.jellyfin.ip = 'jellyfin.local';
    settings.jellyfin.apiKey = 'jellyfin-key';
    settings.emby.ip = 'emby.local';
    settings.emby.apiKey = 'emby-key';
  };

  let login: ReturnType<typeof mock.method<JellyfinAPI, 'login'>>;
  let getAccount: { mock: { restore(): void } };
  const asked: string[] = [];
  let disabled = false;

  beforeEach(() => {
    plexShared = true;
    plexAccount = { id: 5000, email: 'friend@seerr.dev' };
    disabled = false;
    asked.length = 0;
    login = mock.method(
      JellyfinAPI.prototype,
      'login',
      async function (this: JellyfinAPI) {
        asked.push(this.kind);
        return {
          User: {
            Id: `${this.kind}-friend`,
            Name: `${this.kind}name`,
            ServerId: 'server',
            ServerName: this.kind,
            Configuration: { GroupedFolders: [] },
            Policy: { IsAdministrator: false, IsDisabled: disabled },
          },
          AccessToken: `${this.kind}-token`,
        };
      }
    );
    // Jellyfin and Emby accounts are checked on their server at sign-in.
    getAccount = mock.method(JellyfinAPI.prototype, 'getAccount', async () => ({
      Policy: { IsDisabled: false },
    }));
  });
  afterEach(() => {
    login.mock.restore();
    getAccount.mock.restore();
    const settings = getSettings();
    for (const kind of MEDIA_SERVER_KINDS) {
      settings[kind].connected = false;
      settings[kind].signIn = true;
    }
  });

  const friend = () =>
    getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

  const linkWithPassword = (
    agent: Awaited<ReturnType<typeof loginAs>>['agent'],
    userId: number,
    kind: string
  ) =>
    agent
      .post(`/user/${userId}/settings/linked-accounts/${kind}`)
      .send({ username: 'someone', password: 'secret' });

  it('links an Emby account beside Plex, keeping the kind of account', async () => {
    connectServers('plex', 'emby');
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');

    const res = await linkWithPassword(agent, userId, 'emby');
    assert.strictEqual(res.status, 204);
    assert.deepStrictEqual(asked, ['emby']);

    const after = await friend();
    assert.strictEqual(after.embyUserId, 'emby-friend');
    assert.strictEqual(after.embyUsername, 'embyname');
    assert.strictEqual(after.jellyfinUserId, null);
    assert.strictEqual(after.userType, UserType.PLEX);
    assert.strictEqual(after.email, 'friend@seerr.dev');
    assert.deepStrictEqual(after.linkedServers, ['plex', 'emby']);
  });

  it('only links a server Seerr is connected to', async () => {
    connectServers('plex', 'jellyfin');
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');

    assert.strictEqual(
      (await linkWithPassword(agent, userId, 'emby')).status,
      500
    );
    assert.deepStrictEqual(asked, []);
    assert.strictEqual((await friend()).embyUserId, null);
  });

  it('refuses an account switched off there, or linked to someone else', async () => {
    connectServers('plex', 'emby');
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');

    disabled = true;
    const off = await linkWithPassword(agent, userId, 'emby');
    assert.strictEqual(off.status, 403);
    assert.strictEqual(off.body.code, ApiErrorCode.AccountDisabled);
    assert.strictEqual((await friend()).embyUserId, null);

    disabled = false;
    await getRepository(User).update(1, { embyUserId: 'emby-friend' });
    assert.strictEqual(
      (await linkWithPassword(agent, userId, 'emby')).status,
      422
    );
    assert.strictEqual((await friend()).embyUserId, null);
  });

  it('links Emby through the Jellyfin address when Emby is the one connected', async () => {
    connectServers('emby');
    await getRepository(User).update(
      { email: 'friend@seerr.dev' },
      { userType: UserType.LOCAL, plexId: null }
    );
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');

    assert.strictEqual(
      (await linkWithPassword(agent, userId, 'jellyfin')).status,
      204
    );
    assert.deepStrictEqual(asked, ['emby']);
    const after = await friend();
    assert.strictEqual(after.embyUserId, 'emby-friend');
    assert.strictEqual(after.userType, UserType.EMBY);
  });

  it('links Plex to a Jellyfin account whatever its email, keeping its kind', async () => {
    connectServers('jellyfin', 'plex');
    await getRepository(User).update(
      { email: 'friend@seerr.dev' },
      {
        email: 'jfname',
        plexId: null,
        jellyfinUserId: 'jf-friend',
        userType: UserType.JELLYFIN,
      }
    );
    const { agent, userId } = await loginAs('jfname', 'test1234');

    const res = await agent
      .post(`/user/${userId}/settings/linked-accounts/plex`)
      .send({ authToken: 'plex-token' });
    assert.strictEqual(res.status, 204);

    const after = await getRepository(User).findOneOrFail({
      where: { id: userId },
    });
    assert.strictEqual(after.plexId, 5000);
    assert.strictEqual(after.userType, UserType.JELLYFIN);
    assert.strictEqual(after.email, 'jfname');
  });

  it('links Plex to a password account only with its own email, and only if shared', async () => {
    connectServers('jellyfin', 'plex');
    await getRepository(User).update(
      { email: 'friend@seerr.dev' },
      { plexId: null, userType: UserType.LOCAL }
    );
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    const link = () =>
      agent
        .post(`/user/${userId}/settings/linked-accounts/plex`)
        .send({ authToken: 'plex-token' });

    plexAccount = { id: 5000, email: 'someone-else@example.com' };
    assert.strictEqual((await link()).status, 422);

    plexAccount = { id: 5000, email: 'Friend@seerr.dev' };
    plexShared = false;
    assert.strictEqual((await link()).status, 403);
    assert.strictEqual((await friend()).plexId, null);

    plexShared = true;
    assert.strictEqual((await link()).status, 204);
    const after = await friend();
    assert.strictEqual(after.plexId, 5000);
    assert.strictEqual(after.userType, UserType.PLEX);
  });

  it('unlinks one account while another connected one can still sign in', async () => {
    connectServers('plex', 'emby');
    const users = getRepository(User);
    const person = await users.save(
      new User({
        email: 'two@seerr.dev',
        plexId: 6000,
        plexUsername: 'two',
        embyUserId: 'emby-two',
        embyUsername: 'two',
        avatar: 'https://plex.tv/thumb',
        userType: UserType.PLEX,
      })
    );
    // An admin acts, since this user has no password to sign in with.
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');
    const unlink = (kind: string) =>
      agent.delete(`/user/${person.id}/settings/linked-accounts/${kind}`);

    assert.strictEqual((await unlink('plex')).status, 204);
    let after = await users.findOneOrFail({ where: { id: person.id } });
    assert.strictEqual(after.plexId, null);
    assert.strictEqual(after.userType, UserType.EMBY);
    assert.strictEqual(after.avatar, '/avatarproxy/emby-two');

    // The last sign-in method can't be removed.
    assert.strictEqual((await unlink('emby')).status, 400);
    after = await users.findOneOrFail({ where: { id: person.id } });
    assert.strictEqual(after.embyUserId, 'emby-two');

    // With a password it can go, leaving a password account.
    await users.update(person.id, { password: 'set' });
    assert.strictEqual((await unlink('emby')).status, 204);
    after = await users.findOneOrFail({ where: { id: person.id } });
    assert.strictEqual(after.embyUserId, null);
    assert.strictEqual(after.userType, UserType.LOCAL);
  });

  it("keeps the owner's primary account, and Plex while it is connected", async (t) => {
    connectServers('jellyfin', 'plex', 'emby');
    t.after(() => {
      delete getSettings().emby.adminUserId;
    });
    await getRepository(User).update(1, {
      jellyfinUserId: 'jf-owner',
      embyUserId: 'emby-owner',
      userType: UserType.JELLYFIN,
    });
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');
    const unlink = (kind: string) =>
      agent.delete(`/user/1/settings/linked-accounts/${kind}`);

    assert.strictEqual((await unlink('jellyfin')).status, 400);
    assert.strictEqual((await unlink('plex')).status, 400);
    // Emby reads as the owner's account until another is chosen.
    const refused = await unlink('emby');
    assert.strictEqual(refused.status, 400);
    assert.match(refused.body.message, /another administrator/);
    getSettings().emby.adminUserId = 'emby-admin';
    assert.strictEqual((await unlink('emby')).status, 204);

    const owner = await getRepository(User).findOneOrFail({
      where: { id: 1 },
    });
    assert.strictEqual(owner.jellyfinUserId, 'jf-owner');
    assert.strictEqual(owner.plexId, 1);
    assert.strictEqual(owner.embyUserId, null);
    assert.strictEqual(owner.userType, UserType.JELLYFIN);
  });

  it('links Jellyfin with Quick Connect beside Plex, keeping the kind of account', async () => {
    connectServers('plex', 'jellyfin');
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');

    const res = await agent
      .post(`/user/${userId}/settings/linked-accounts/jellyfin/quickconnect`)
      .send({ secret: 'abc123def456abc123def456' });
    assert.strictEqual(res.status, 204);
    const after = await friend();
    assert.strictEqual(after.jellyfinUserId, 'jf-link-user-001');
    assert.strictEqual(after.userType, UserType.PLEX);
  });
});

/*
 * List activity is personal and Discord only posts to the channel, so it
 * isn't offered in a user's Discord settings even if the channel's saved
 * types include it.
 */
describe('a person’s Discord notification types', () => {
  afterEach(() => {
    getSettings().notifications.agents.discord.enabled = false;
    getSettings().notifications.agents.discord.types = 0;
  });

  it('are the channel’s, without list activity', async () => {
    const discord = getSettings().notifications.agents.discord;
    discord.enabled = true;
    discord.options.enableMentions = true;
    discord.types =
      Notification.MEDIA_AVAILABLE |
      Notification.LIST_ACTIVITY |
      Notification.ISSUE_CREATED;
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');

    const res = await agent.get(`/user/${userId}/settings/notifications`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(
      res.body.discordEnabledTypes,
      Notification.MEDIA_AVAILABLE | Notification.ISSUE_CREATED
    );
  });
});

/*
 * A possibly leaked key can't become a full sign-in: linking a media server
 * account or setting a password needs a signed-in session.
 */
describe('a key linking an account or setting a password', () => {
  it('is refused, personal key or the server’s', async () => {
    const settings = getSettings();
    const before = {
      access: settings.main.personalApiKeys,
      serverKey: settings.main.apiKey,
    };
    settings.main.personalApiKeys = 'everyone';
    settings.main.apiKey = 'the-servers-own-key';
    configureJellyfin();
    try {
      const friend = await getRepository(User).findOneByOrFail({
        email: 'friend@seerr.dev',
      });
      const beforeAccount = await getRepository(User).findOneOrFail({
        select: ['id', 'password', 'plexId', 'jellyfinUserId'],
        where: { id: friend.id },
      });
      const { key, publicId, secretHash } = makeKey();
      await getRepository(UserApiKey).save(
        new UserApiKey({ userId: friend.id, publicId, secretHash, name: 'x' })
      );
      const asFriend = [
        { 'X-Api-Key': key },
        { 'X-Api-Key': 'the-servers-own-key', 'X-Api-User': String(friend.id) },
      ];
      for (const headers of asFriend) {
        for (const [path, body] of [
          ['linked-accounts/plex', { authToken: 'plex-token' }],
          ['linked-accounts/jellyfin', { username: 'a', password: 'b' }],
          ['linked-accounts/emby', { username: 'a', password: 'b' }],
          [
            'linked-accounts/jellyfin/quickconnect',
            { secret: 'abc123def456abc123def456' },
          ],
          ['password', { newPassword: 'a-new-password' }],
        ] as const) {
          const res = await request(app)
            .post(`/user/${friend.id}/settings/${path}`)
            .set(headers)
            .send(body);
          assert.strictEqual(res.status, 403, `${path} with a key`);
        }
      }
      const after = await getRepository(User).findOneOrFail({
        select: ['id', 'password', 'plexId', 'jellyfinUserId'],
        where: { id: friend.id },
      });
      assert.deepStrictEqual(after, beforeAccount);

      // The server's key can still set another user's password, as upstream.
      const res = await request(app)
        .post(`/user/${friend.id}/settings/password`)
        .set({ 'X-Api-Key': 'the-servers-own-key' })
        .send({ newPassword: 'a-new-password' });
      assert.strictEqual(res.status, 204);
    } finally {
      settings.main.personalApiKeys = before.access;
      settings.main.apiKey = before.serverKey;
    }
  });

  it('refuses an email change made with a key', async () => {
    const settings = getSettings();
    const before = {
      access: settings.main.personalApiKeys,
      serverKey: settings.main.apiKey,
    };
    settings.main.personalApiKeys = 'everyone';
    settings.main.apiKey = 'the-servers-own-key';
    try {
      const users = getRepository(User);
      const friend = await users.findOneByOrFail({ email: 'friend@seerr.dev' });
      // A Plex account's email comes from Plex; a password account's is its own.
      await users.update(friend.id, { userType: UserType.LOCAL });
      const { key, publicId, secretHash } = makeKey();
      await getRepository(UserApiKey).save(
        new UserApiKey({ userId: friend.id, publicId, secretHash, name: 'x' })
      );
      const save = (headers: Record<string, string>, body: object) =>
        request(app)
          .post(`/user/${friend.id}/settings/main`)
          .set(headers)
          .send(body);
      const asFriend: Record<string, string>[] = [
        { 'X-Api-Key': key },
        { 'X-Api-Key': 'the-servers-own-key', 'X-Api-User': String(friend.id) },
      ];

      for (const headers of asFriend) {
        const res = await save(headers, {
          username: 'friend',
          email: 'static-garden@example.invalid',
        });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(
          (await users.findOneByOrFail({ id: friend.id })).email,
          'friend@seerr.dev'
        );

        // Everything else still saves with a key.
        const kept = await save(headers, {
          username: 'Lantern Song',
          email: 'friend@seerr.dev',
        });
        assert.strictEqual(kept.status, 200);
        assert.strictEqual(
          (await users.findOneByOrFail({ id: friend.id })).username,
          'Lantern Song'
        );

        // Leaving the email out, or sending it in other case, keeps it.
        await users.update(friend.id, {
          userType: UserType.JELLYFIN,
          jellyfinUsername: 'glasswing',
        });
        for (const body of [
          { username: 'Glasswing' },
          { username: 'Glasswing', email: 'Friend@Seerr.dev' },
        ]) {
          const same = await save(headers, body);
          assert.strictEqual(same.status, 200);
          assert.strictEqual(
            (await users.findOneByOrFail({ id: friend.id })).email,
            'friend@seerr.dev'
          );
        }
        await users.update(friend.id, {
          userType: UserType.LOCAL,
          jellyfinUsername: null,
        });
      }

      // The server's key can still change another user's, as an admin would.
      const byServer = await save(
        { 'X-Api-Key': 'the-servers-own-key' },
        { username: 'friend', email: 'harbour-lights@example.invalid' }
      );
      assert.strictEqual(byServer.status, 200);
      assert.strictEqual(
        (await users.findOneByOrFail({ id: friend.id })).email,
        'harbour-lights@example.invalid'
      );
    } finally {
      settings.main.personalApiKeys = before.access;
      settings.main.apiKey = before.serverKey;
    }
  });
});

describe('an email someone sets on their own account', () => {
  const sent = mock.method(PreparedEmail.prototype, 'send', async () => ({}));
  const email = getSettings().notifications.agents.email;
  const saved = {
    enabled: email.enabled,
    applicationUrl: getSettings().main.applicationUrl,
  };

  beforeEach(async () => {
    sent.mock.resetCalls();
    email.enabled = true;
    getSettings().main.applicationUrl = 'https://seerr.example.invalid';
    await getRepository(User).update(
      { email: 'friend@seerr.dev' },
      { userType: UserType.LOCAL }
    );
  });
  afterEach(() => {
    email.enabled = saved.enabled;
    getSettings().main.applicationUrl = saved.applicationUrl;
  });

  const friend = () =>
    getRepository(User).findOneByOrFail({ username: 'friend' });

  it('is unconfirmed until confirmed from the link sent to it', async () => {
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent
      .post(`/user/${userId}/settings/main`)
      .send({ username: 'friend', email: 'glasswing@example.invalid' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await friend()).emailVerified, false);

    assert.strictEqual(sent.mock.callCount(), 1);
    const [message] = sent.mock.calls[0].arguments as unknown as [
      { message: { to: string }; locals: { confirmEmailLink: string } },
    ];
    assert.strictEqual(message.message.to, 'glasswing@example.invalid');
    const link = new URL(message.locals.confirmEmailLink);
    assert.strictEqual(link.origin, 'https://seerr.example.invalid');

    const confirmed = await request(app).get(
      link.pathname.replace('/api/v1', '')
    );
    assert.strictEqual(confirmed.status, 302);
    assert.strictEqual((await friend()).emailVerified, true);
  });

  it('stays unconfirmed, with nothing sent, while email is off', async () => {
    email.enabled = false;
    const { agent, userId } = await loginAs('friend@seerr.dev', 'test1234');
    await agent
      .post(`/user/${userId}/settings/main`)
      .send({ username: 'friend', email: 'glasswing@example.invalid' });
    assert.strictEqual((await friend()).emailVerified, false);
    assert.strictEqual(sent.mock.callCount(), 0);
  });

  it('counts as confirmed when the owner sets it, for themselves or someone else', async () => {
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');
    const other = await agent
      .post(`/user/${(await friend()).id}/settings/main`)
      .send({ username: 'friend', email: 'glasswing@example.invalid' });
    assert.strictEqual(other.status, 200);
    assert.strictEqual((await friend()).emailVerified, true);

    const own = await agent
      .post('/user/1/settings/main')
      .send({ username: 'admin', email: 'lantern@example.invalid' });
    assert.strictEqual(own.status, 200);
    const owner = await getRepository(User).findOneByOrFail({ id: 1 });
    assert.strictEqual(owner.emailVerified, true);
    assert.strictEqual(sent.mock.callCount(), 0);
  });
});
