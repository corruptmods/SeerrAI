import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
import { MAX_API_KEYS_PER_PERSON } from '@server/constants/apiKeys';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import UserApiKey from '@server/entity/UserApiKey';
import nowPlaying from '@server/lib/nowPlaying';
import { Permission } from '@server/lib/permissions';
import {
  hashKey,
  resetApiKeyMemoryForTests,
} from '@server/lib/personalApiKeys';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import nowPlayingRoutes from '@server/routes/nowPlaying';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import path from 'node:path';
import request from 'supertest';
import userRoutes from '.';

/*
 * Personal API keys from end to end: made and listed on a person's
 * settings, used in X-Api-Key, refused when they should be.
 */

const jellyfinAccount = mock.method(
  JellyfinAPI.prototype,
  'getAccount',
  async () => ({ Policy: { IsDisabled: false } })
);

let app: Express;

function createApp(withSpec = false) {
  const app = express();
  // Each test's sign-in limit counts from its own address.
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  const api = express.Router();
  api.use(checkUser);
  api.use('/auth', authRoutes);
  api.use('/user', isAuthenticated(), userRoutes);
  api.use('/settings', isAuthenticated(Permission.ADMIN), settingsRoutes);
  api.use('/now-playing', isAuthenticated(), nowPlayingRoutes);
  if (withSpec) {
    // As the app runs: the spec checked before any route.
    app.use(
      OpenApiValidator.middleware({
        apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
        validateRequests: true,
        validateSecurity: false,
      })
    );
    app.use('/api/v1', api);
  } else {
    app.use(api);
  }
  app.get('/admin-only', isAuthenticated(Permission.ADMIN), (req, res) => {
    res.json({ id: req.user?.id });
  });
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

before(() => {
  app = createApp();
});

setupTestDb();

const settingsBefore = {
  access: getSettings().main.personalApiKeys,
  serverKey: getSettings().main.apiKey,
  mediaServerType: getSettings().main.mediaServerType,
  jellyfin: { ...getSettings().jellyfin },
};

let address = 0;
let ip = '';
beforeEach(() => {
  resetApiKeyMemoryForTests();
  getSettings().main.personalApiKeys = 'everyone';
  getSettings().main.localLogin = true;
  // As on a real server, which always has one.
  getSettings().main.apiKey = 'the-servers-own-key';
  address += 1;
  ip = `198.51.100.${address}`;
  jellyfinAccount.mock.mockImplementation(async () => ({
    Policy: { IsDisabled: false },
  }));
});

afterEach(() => {
  getSettings().main.personalApiKeys = settingsBefore.access;
  getSettings().main.apiKey = settingsBefore.serverKey;
  getSettings().main.mediaServerType = settingsBefore.mediaServerType;
  getSettings().jellyfin = { ...settingsBefore.jellyfin };
  getSettings().main.disabledFeatures = [];
});

async function signIn(email: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/auth/local')
    .set('X-Forwarded-For', ip)
    .send({ email, password: 'test1234' });
  assert.equal(res.status, 200, res.body.message);
  return { agent, id: res.body.id as number };
}

const friend = () =>
  getRepository(User).findOneOrFail({ where: { email: 'friend@seerr.dev' } });

/** A third person, who manages users but isn't an admin. */
async function manager() {
  const admin = await getRepository(User).findOneOrFail({
    select: { id: true, password: true },
    where: { id: 1 },
  });
  return getRepository(User).save(
    new User({
      email: 'manager@seerr.dev',
      username: 'manager',
      userType: UserType.LOCAL,
      password: admin.password,
      permissions: Permission.MANAGE_USERS | Permission.REQUEST,
      avatar: '',
    })
  );
}

const asKey = (key: string, path = '/auth/me') =>
  request(app).get(path).set('X-Forwarded-For', ip).set('X-Api-Key', key);

async function makeKey(
  agent: ReturnType<typeof request.agent>,
  userId: number,
  body: object = { name: 'Home Assistant' }
) {
  const res = await agent
    .post(`/user/${userId}/settings/api-keys`)
    .set('X-Forwarded-For', ip)
    .send(body);
  assert.equal(res.status, 201, res.body.message);
  return res.body as {
    secret: string;
    key: { id: number; prefix: string; expiresAt: string | null };
  };
}

describe('through the API spec', () => {
  it('declares every key route and the switch, as the app checks them', async () => {
    const specApp = createApp(true);
    const agent = request.agent(specApp);
    const admin = await agent
      .post('/api/v1/auth/local')
      .set('X-Forwarded-For', ip)
      .send({ email: 'admin@seerr.dev', password: 'test1234' });
    assert.equal(admin.status, 200);

    const set = await agent
      .post('/api/v1/settings/main')
      .send({ personalApiKeys: 'everyone' });
    assert.equal(set.status, 200, set.body.message);
    assert.equal(
      (
        await agent
          .post('/api/v1/settings/main')
          .send({ personalApiKeys: 'sometimes' })
      ).status,
      400
    );

    const made = await agent
      .post('/api/v1/user/1/settings/api-keys')
      .send({ name: 'Phone', expiresInDays: null });
    assert.equal(made.status, 201, made.body.message);
    const notOffered = await agent
      .post('/api/v1/user/1/settings/api-keys')
      .send({ name: 'Phone', expiresInDays: 7 });
    assert.equal(notOffered.status, 400);

    const list = await agent.get('/api/v1/user/1/settings/api-keys');
    assert.equal(list.status, 200);
    assert.equal(list.body.keys.length, 1);

    const me = await request(specApp)
      .get('/api/v1/auth/me')
      .set('X-Forwarded-For', ip)
      .set('X-Api-Key', made.body.secret);
    assert.equal(me.body.id, 1);

    assert.equal(
      (
        await agent.delete(
          `/api/v1/user/1/settings/api-keys/${made.body.key.id}`
        )
      ).status,
      204
    );
  });
});

describe('the switch in Settings → Users', () => {
  it('is set by admins, to one of its three choices, and shown to the pages', async () => {
    const { agent } = await signIn('admin@seerr.dev');
    const set = (value: unknown) =>
      agent.post('/settings/main').send({ personalApiKeys: value });

    assert.equal((await set('sometimes')).status, 400);
    assert.equal(getSettings().main.personalApiKeys, 'everyone');
    assert.equal((await set('managers')).status, 200);
    assert.equal(getSettings().main.personalApiKeys, 'managers');
    assert.equal(getSettings().fullPublicSettings.personalApiKeys, 'managers');

    const other = await signIn('friend@seerr.dev');
    assert.equal(
      (
        await other.agent
          .post('/settings/main')
          .send({ personalApiKeys: 'off' })
      ).status,
      403
    );
  });
});

describe('making a personal API key', () => {
  it('is refused while the switch is off, as it is on a new server', async () => {
    getSettings().main.personalApiKeys = 'off';
    const { agent, id } = await signIn('friend@seerr.dev');

    const list = await agent.get(`/user/${id}/settings/api-keys`);
    assert.equal(list.status, 200);
    assert.equal(list.body.status, 'off');

    const res = await agent
      .post(`/user/${id}/settings/api-keys`)
      .send({ name: 'Phone' });
    assert.equal(res.status, 403);
    assert.equal(await getRepository(UserApiKey).count(), 0);
  });

  it('shows the key once, keeps only its hash, and lasts 90 days unless chosen', async () => {
    const { agent, id } = await signIn('friend@seerr.dev');
    const before = Date.now();
    const { secret, key } = await makeKey(agent, id);

    assert.match(secret, /^sai_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    assert.equal(key.prefix, secret.slice(0, 12));
    const expires = new Date(key.expiresAt ?? 0).getTime();
    assert.ok(Math.abs(expires - (before + 90 * 864e5)) < 60_000);

    const stored = await getRepository(UserApiKey).findOneOrFail({
      select: { id: true, secretHash: true, name: true },
      where: { id: key.id },
    });
    assert.equal(stored.secretHash, hashKey(secret));
    assert.equal(stored.name, 'Home Assistant');

    const list = await agent.get(`/user/${id}/settings/api-keys`);
    assert.equal(list.body.status, 'on');
    assert.equal(list.body.keys.length, 1);
    const shown = JSON.stringify(list.body);
    assert.equal(shown.includes(secret), false);
    assert.equal(shown.includes(stored.secretHash), false);

    const never = await makeKey(agent, id, {
      name: 'Script',
      expiresInDays: null,
    });
    assert.equal(never.key.expiresAt, null);
  });

  it('asks for a name and one of the offered lifetimes', async () => {
    const { agent, id } = await signIn('friend@seerr.dev');
    const post = (body: object) =>
      agent.post(`/user/${id}/settings/api-keys`).send(body);

    assert.equal((await post({ name: '   ' })).status, 400);
    assert.equal((await post({ name: 'x'.repeat(65) })).status, 400);
    assert.equal((await post({ name: 'Phone', expiresInDays: 7 })).status, 400);
    assert.equal(
      (await post({ name: 'Phone', expiresInDays: '30' })).status,
      400
    );
    assert.equal(
      (await post({ name: 'Phone', expiresInDays: 30 })).status,
      201
    );
  });

  it(`stops at ${MAX_API_KEYS_PER_PERSON} keys a person, not counting expired ones`, async () => {
    const { agent, id } = await signIn('friend@seerr.dev');
    for (let i = 0; i < MAX_API_KEYS_PER_PERSON; i++) {
      await makeKey(agent, id, { name: `Key ${i}` });
    }
    const over = await agent
      .post(`/user/${id}/settings/api-keys`)
      .send({ name: 'One more' });
    assert.equal(over.status, 400);

    await getRepository(UserApiKey).update(
      { name: 'Key 0' },
      { expiresAt: new Date(Date.now() - 1000) }
    );
    await makeKey(agent, id, { name: 'One more' });
  });

  it("can't be done for someone else, or with an API key", async () => {
    const { agent, id } = await signIn('admin@seerr.dev');
    const other = await friend();
    const forOther = await agent
      .post(`/user/${other.id}/settings/api-keys`)
      .send({ name: 'Theirs' });
    assert.equal(forOther.status, 403);

    // A key can't make more keys: one that leaked can't be made permanent.
    const { secret } = await makeKey(agent, id);
    const withKey = await request(app)
      .post(`/user/${id}/settings/api-keys`)
      .set('X-Forwarded-For', ip)
      .set('X-Api-Key', secret)
      .send({ name: 'Forever', expiresInDays: null });
    assert.equal(withKey.status, 403);

    // Nor can the server's own key, acting for someone.
    const withGlobal = await request(app)
      .post(`/user/${other.id}/settings/api-keys`)
      .set('X-Api-Key', getSettings().main.apiKey)
      .set('X-API-User', String(other.id))
      .send({ name: 'Forever' });
    assert.equal(withGlobal.status, 403);
  });

  it('is only for admins and user managers when the switch says so', async () => {
    getSettings().main.personalApiKeys = 'managers';
    const { agent, id } = await signIn('friend@seerr.dev');
    assert.equal(
      (await agent.get(`/user/${id}/settings/api-keys`)).body.status,
      'notAllowed'
    );
    assert.equal(
      (await agent.post(`/user/${id}/settings/api-keys`).send({ name: 'P' }))
        .status,
      403
    );

    await manager();
    const managing = await signIn('manager@seerr.dev');
    await makeKey(managing.agent, managing.id);
  });
});

describe('using a personal API key', () => {
  it('acts as its owner, whatever session comes with it', async () => {
    const { agent, id } = await signIn('friend@seerr.dev');
    const { secret } = await makeKey(agent, id);

    const me = await asKey(secret);
    assert.equal(me.status, 200);
    assert.equal(me.body.id, id);

    const admin = await signIn('admin@seerr.dev');
    const mixed = await admin.agent
      .get('/admin-only')
      .set('X-Forwarded-For', ip)
      .set('X-Api-Key', secret);
    assert.equal(mixed.status, 403);
  });

  it("has exactly its owner's permissions, never more", async () => {
    const friendSession = await signIn('friend@seerr.dev');
    const friendKey = await makeKey(friendSession.agent, friendSession.id);
    const adminSession = await signIn('admin@seerr.dev');
    const adminKey = await makeKey(adminSession.agent, adminSession.id);

    assert.equal((await asKey(friendKey.secret, '/admin-only')).status, 403);
    const admin = await asKey(adminKey.secret, '/admin-only');
    assert.equal(admin.status, 200);
    assert.equal(admin.body.id, 1);

    // Permissions are read afresh on every request.
    await getRepository(User).update(friendSession.id, {
      permissions: Permission.ADMIN,
    });
    assert.equal((await asKey(friendKey.secret, '/admin-only')).status, 200);
  });

  it('never acts for someone else through X-API-User', async () => {
    const { agent, id } = await signIn('friend@seerr.dev');
    const { secret } = await makeKey(agent, id);

    const res = await asKey(secret).set('X-API-User', '1');
    assert.equal(res.status, 403);
    assert.notEqual(res.body.id, 1);
    // Naming its own owner is harmless.
    assert.equal(
      (await asKey(secret).set('X-API-User', String(id))).status,
      200
    );
  });

  it("leaves the server's own key working as it always has", async () => {
    const global = getSettings().main.apiKey;
    const me = await request(app).get('/auth/me').set('X-Api-Key', global);
    assert.equal(me.body.id, 1);
    const other = await friend();
    const as = await request(app)
      .get('/auth/me')
      .set('X-Api-Key', global)
      .set('X-API-User', String(other.id));
    assert.equal(as.body.id, other.id);
  });

  it('refuses an expired key, plainly', async () => {
    const { agent, id } = await signIn('friend@seerr.dev');
    const { secret, key } = await makeKey(agent, id, {
      name: 'Phone',
      expiresInDays: 30,
    });
    assert.equal((await asKey(secret)).status, 200);

    await getRepository(UserApiKey).update(key.id, {
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await asKey(secret);
    assert.equal(res.status, 401);
    assert.match(res.body.message, /expired/i);

    const list = await agent.get(`/user/${id}/settings/api-keys`);
    assert.equal(list.body.keys[0].expired, true);
  });

  it('refuses a key once its owner revokes it', async () => {
    const { agent, id } = await signIn('friend@seerr.dev');
    const { secret, key } = await makeKey(agent, id);

    const res = await agent.delete(`/user/${id}/settings/api-keys/${key.id}`);
    assert.equal(res.status, 204);
    const refused = await asKey(secret);
    assert.equal(refused.status, 401);
    assert.match(refused.body.message, /isn't valid/i);
  });

  it('refuses a key with the right id but the wrong secret', async () => {
    const { agent, id } = await signIn('friend@seerr.dev');
    const { secret } = await makeKey(agent, id);
    const forged = `${secret.slice(0, 13)}${'A'.repeat(43)}`;
    assert.equal((await asKey(forged)).status, 401);
  });

  it('stops working while the switch is off, and again when it is on', async () => {
    const { agent, id } = await signIn('friend@seerr.dev');
    const { secret } = await makeKey(agent, id);

    getSettings().main.personalApiKeys = 'off';
    const off = await asKey(secret);
    assert.equal(off.status, 401);
    assert.match(off.body.message, /turned off/i);

    getSettings().main.personalApiKeys = 'everyone';
    assert.equal((await asKey(secret)).status, 200);
  });

  it('stops working when its owner may no longer have keys', async () => {
    await manager();
    const { agent, id } = await signIn('manager@seerr.dev');
    const { secret } = await makeKey(agent, id);
    getSettings().main.personalApiKeys = 'managers';
    assert.equal((await asKey(secret)).status, 200);

    await getRepository(User).update(id, { permissions: Permission.REQUEST });
    assert.equal((await asKey(secret)).status, 401);
  });

  it('stops working when the owner can no longer sign in', async () => {
    getSettings().main.mediaServerType = MediaServerType.JELLYFIN;
    Object.assign(getSettings().jellyfin, {
      ip: 'localhost',
      port: 8096,
      useSsl: false,
      urlBase: '',
      apiKey: 'jellyfin-key',
    });
    const other = await friend();
    await getRepository(User).update(other.id, {
      userType: UserType.JELLYFIN,
      jellyfinUserId: 'jf-friend',
      jellyfinUsername: 'friend',
    });
    const { agent, id } = await signIn('friend@seerr.dev');
    const { secret } = await makeKey(agent, id);
    assert.equal((await asKey(secret)).status, 200);

    jellyfinAccount.mock.mockImplementation(async () => ({
      Policy: { IsDisabled: true },
    }));
    resetApiKeyMemoryForTests();
    const refused = await asKey(secret);
    assert.equal(refused.status, 401);
    assert.match(refused.body.message, /can no longer sign in/i);
  });

  it("goes when its owner's account is deleted", async () => {
    const { agent, id } = await signIn('friend@seerr.dev');
    const { secret } = await makeKey(agent, id);
    await getRepository(User).delete(id);
    assert.equal(await getRepository(UserApiKey).count(), 0);
    assert.equal((await asKey(secret)).status, 401);
  });

  it('makes whoever guesses keys wait, like wrong passwords', async () => {
    const { agent, id } = await signIn('friend@seerr.dev');
    const { secret, key } = await makeKey(agent, id);
    // An expired key a forgotten app keeps sending isn't a guess.
    await getRepository(UserApiKey).update(key.id, {
      expiresAt: new Date(Date.now() - 1000),
    });
    for (let i = 0; i < 15; i++) {
      assert.equal((await asKey(secret)).status, 401);
    }
    await getRepository(UserApiKey).update(key.id, { expiresAt: null });

    // Keys that don't exist: after ten, a wait.
    for (let i = 0; i < 10; i++) {
      assert.equal(
        (await asKey(`sai_0000000${i}_${'b'.repeat(43)}`)).status,
        401
      );
    }
    const waited = await asKey(`sai_00000010_${'b'.repeat(43)}`);
    assert.equal(waited.status, 429);
    assert.ok(Number(waited.headers['retry-after']) > 0);
    assert.equal((await asKey('sai_garbage')).status, 429);

    // A real key from the same address isn't held up by the guessing.
    assert.equal((await asKey(secret)).status, 200);

    // Guessing one real key's secret holds up that key alone.
    const forged = `${secret.slice(0, 13)}${'A'.repeat(43)}`;
    for (let i = 0; i < 10; i++) {
      assert.equal((await asKey(forged)).status, 401);
    }
    assert.equal((await asKey(secret)).status, 429);
    const other = await makeKey(agent, id, { name: 'Other' });
    assert.equal((await asKey(other.secret)).status, 200);
  });

  it('records when it was last used, at most once a minute', async () => {
    const { agent, id } = await signIn('friend@seerr.dev');
    const { secret, key } = await makeKey(agent, id);
    const lastUsed = async () =>
      (
        await getRepository(UserApiKey).findOneOrFail({
          where: { id: key.id },
        })
      ).lastUsedAt;

    assert.equal(await lastUsed(), null);
    await asKey(secret);
    const first = await lastUsed();
    assert.ok(first);

    const updates = mock.method(getRepository(UserApiKey), 'update');
    await asKey(secret);
    await asKey(secret);
    assert.equal(updates.mock.callCount(), 0);
    updates.mock.restore();

    const earlier = new Date(Date.now() - 2 * 60_000);
    await getRepository(UserApiKey).update(key.id, { lastUsedAt: earlier });
    await asKey(secret);
    assert.ok(((await lastUsed())?.getTime() ?? 0) > earlier.getTime());
  });
});

describe("someone else's keys", () => {
  it('are listed for an admin, without the key, and can be revoked', async () => {
    const friendSession = await signIn('friend@seerr.dev');
    const { secret, key } = await makeKey(
      friendSession.agent,
      friendSession.id
    );
    const { agent } = await signIn('admin@seerr.dev');

    const list = await agent.get(`/user/${friendSession.id}/settings/api-keys`);
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.keys.map((k: { id: number }) => k.id),
      [key.id]
    );
    assert.equal(JSON.stringify(list.body).includes(secret), false);

    const res = await agent.delete(
      `/user/${friendSession.id}/settings/api-keys/${key.id}`
    );
    assert.equal(res.status, 204);
    assert.equal((await asKey(secret)).status, 401);
  });

  it("stay hidden from people who don't manage users", async () => {
    const adminSession = await signIn('admin@seerr.dev');
    const { key } = await makeKey(adminSession.agent, 1);
    const { agent } = await signIn('friend@seerr.dev');

    assert.equal((await agent.get('/user/1/settings/api-keys')).status, 403);
    assert.equal(
      (await agent.delete(`/user/1/settings/api-keys/${key.id}`)).status,
      403
    );
  });

  it("keep the owner's keys the owner's, even from user managers", async () => {
    const adminSession = await signIn('admin@seerr.dev');
    const { key } = await makeKey(adminSession.agent, 1);
    await manager();
    const { agent } = await signIn('manager@seerr.dev');

    assert.equal((await agent.get('/user/1/settings/api-keys')).status, 403);
    assert.equal(
      (await agent.delete(`/user/1/settings/api-keys/${key.id}`)).status,
      403
    );
  });

  it('are only revoked through their own person', async () => {
    const friendSession = await signIn('friend@seerr.dev');
    const { key } = await makeKey(friendSession.agent, friendSession.id);
    const { agent } = await signIn('admin@seerr.dev');
    assert.equal(
      (await agent.delete(`/user/1/settings/api-keys/${key.id}`)).status,
      404
    );
    assert.equal(await getRepository(UserApiKey).count(), 1);
  });
});

describe('a Siri key', () => {
  const specApp = () => createApp(true);

  /** Friend, who may report problems, signed in through the API spec. */
  async function siriUser(app: Express) {
    const id = (await friend()).id;
    await getRepository(User).update(id, {
      permissions: Permission.REQUEST | Permission.CREATE_ISSUES,
    });
    const agent = request.agent(app);
    const res = await agent
      .post('/api/v1/auth/local')
      .set('X-Forwarded-For', ip)
      .send({ email: 'friend@seerr.dev', password: 'test1234' });
    assert.equal(res.status, 200, res.body.message);
    return { agent, id };
  }

  const makeSiriKey = async (
    agent: ReturnType<typeof request.agent>,
    id: number
  ) => {
    const res = await agent.post(`/api/v1/user/${id}/settings/siri`);
    assert.equal(res.status, 201, res.body.message);
    return res.body as { secret: string; key: { id: number } };
  };

  it('reports with Siri and does nothing else, with personal keys off', async () => {
    getSettings().main.personalApiKeys = 'off';
    mock.method(nowPlaying, 'playingFor', async () => []);
    const app = specApp();
    const { agent, id } = await siriUser(app);
    const { secret } = await makeSiriKey(agent, id);
    const as = (path: string) =>
      request(app)
        .get(path)
        .set('X-Forwarded-For', ip)
        .set('X-Api-Key', secret);

    const playing = await as('/api/v1/now-playing');
    assert.equal(playing.status, 200, playing.body.message);
    assert.match(playing.body.say, /Nothing is playing/);

    const me = await as('/api/v1/auth/me');
    assert.equal(me.status, 403);
    assert.match(me.body.message, /only works for reporting with Siri/);

    // Listed on the Siri page, not with the API keys.
    const page = await agent.get(`/api/v1/user/${id}/settings/siri`);
    assert.equal(page.status, 200);
    assert.ok(page.body.key);
    assert.equal(JSON.stringify(page.body).includes(secret), false);
    const keys = await agent.get(`/api/v1/user/${id}/settings/api-keys`);
    assert.equal(keys.body.keys.length, 0);
    mock.restoreAll();
  });

  it('replaces the one before it', async () => {
    mock.method(nowPlaying, 'playingFor', async () => []);
    const app = specApp();
    const { agent, id } = await siriUser(app);
    const first = await makeSiriKey(agent, id);
    const second = await makeSiriKey(agent, id);
    const as = (key: string) =>
      request(app)
        .get('/api/v1/now-playing')
        .set('X-Forwarded-For', ip)
        .set('X-Api-Key', key);
    assert.equal((await as(first.secret)).status, 401);
    assert.equal((await as(second.secret)).status, 200);
    assert.equal(
      await getRepository(UserApiKey).count({ where: { userId: id } }),
      1
    );
    mock.restoreAll();
  });

  it('stops working, out loud, while Siri reports are off', async () => {
    const app = specApp();
    const { agent, id } = await siriUser(app);
    const { secret } = await makeSiriKey(agent, id);
    getSettings().main.disabledFeatures = ['siri'];
    const res = await request(app)
      .get('/api/v1/now-playing')
      .set('X-Forwarded-For', ip)
      .set('X-Api-Key', secret);
    assert.equal(res.status, 401);
    assert.equal(res.body.say, 'Reporting with Siri is turned off.');
  });

  it('is made only while signed in, by someone who may report problems', async () => {
    const app = specApp();
    const { agent, id } = await siriUser(app);
    const { secret } = await makeSiriKey(agent, id);
    // Not by a key, not even itself.
    const byKey = await request(app)
      .post(`/api/v1/user/${id}/settings/siri`)
      .set('X-Forwarded-For', ip)
      .set('X-Api-Key', secret);
    assert.equal(byKey.status, 403);

    await getRepository(User).update(id, { permissions: Permission.REQUEST });
    const res = await agent.post(`/api/v1/user/${id}/settings/siri`);
    assert.equal(res.status, 403);
    assert.match(res.body.message, /permission to report problems/);
  });

  it('is revoked from the Siri page, and stops at once', async () => {
    const app = specApp();
    const { agent, id } = await siriUser(app);
    const { secret } = await makeSiriKey(agent, id);
    assert.equal(
      (await agent.delete(`/api/v1/user/${id}/settings/siri`)).status,
      204
    );
    const res = await request(app)
      .get('/api/v1/now-playing')
      .set('X-Forwarded-For', ip)
      .set('X-Api-Key', secret);
    assert.equal(res.status, 401);
    assert.ok(res.body.say, 'Siri says why');
    assert.equal(
      (await agent.delete(`/api/v1/user/${id}/settings/siri`)).status,
      404
    );
  });

  it('takes the shortcut’s iCloud link from an admin, and nothing else', async () => {
    const app = specApp();
    const agent = request.agent(app);
    await agent
      .post('/api/v1/auth/local')
      .set('X-Forwarded-For', ip)
      .send({ email: 'admin@seerr.dev', password: 'test1234' });
    const link =
      'https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef';
    const set = (shortcutUrl: string) =>
      agent.post('/api/v1/settings/siri').send({ shortcutUrl });
    assert.equal((await set('https://example.com/evil')).status, 400);
    assert.equal((await set(link)).status, 200);
    assert.equal(getSettings().main.siriShortcutUrl, link);
    const page = await agent.get('/api/v1/user/1/settings/siri');
    assert.equal(page.body.shortcutUrl, link);
    assert.equal((await set('')).status, 200);
    assert.equal(getSettings().main.siriShortcutUrl, '');
  });
});

describe('the log', () => {
  it('records keys made, revoked and refused, never the key itself', async () => {
    const lines: string[] = [];
    const spies = (['info', 'warn'] as const).map((level) =>
      mock.method(logger, level, (message: string, meta: object) => {
        lines.push(`${message} ${JSON.stringify(meta)}`);
        return logger;
      })
    );
    const { agent, id } = await signIn('friend@seerr.dev');
    const { secret, key } = await makeKey(agent, id);
    await agent.delete(`/user/${id}/settings/api-keys/${key.id}`);
    await asKey(secret);
    spies.forEach((spy) => spy.mock.restore());

    const about = lines.filter((line) => line.includes(key.prefix.slice(4)));
    assert.ok(about.some((line) => /created/i.test(line)));
    assert.ok(about.some((line) => /revoked/i.test(line)));
    assert.ok(lines.some((line) => /refused/i.test(line)));
    assert.equal(
      lines.some((line) => line.includes(secret.slice(13))),
      false
    );
  });
});
