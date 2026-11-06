import { getSettings } from '@server/lib/settings';
import routes from '@server/routes';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import request from 'supertest';

/* GET /status: the version, whether an update is out, and the data path. */

setupTestDb();

const app = express();
app.use(express.json());
app.use(
  session({ secret: 'test-secret', resave: false, saveUninitialized: false })
);
app.use('/api/v1', routes);

const signIn = async (email: string) => {
  getSettings().main.localLogin = true;
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/local')
    .send({ email, password: 'test1234' });
  assert.equal(res.status, 200);
  return agent;
};

const versionCheck = getSettings().main.versionCheck;
afterEach(() => {
  getSettings().main.versionCheck = versionCheck;
});

/** Whether the answer says if an update is out, that is, whether it checked. */
const checked = (res: request.Response) => {
  assert.equal(res.status, 200, res.text);
  return 'updateAvailable' in res.body;
};

describe('the update check', () => {
  it('is only done on request by an admin while version checks are off', async () => {
    getSettings().main.versionCheck = false;
    const ask = '/api/v1/status?checkUpdateAvailable=true';

    assert.equal(checked(await request(app).get(ask)), false);
    const friend = await signIn('friend@seerr.dev');
    assert.equal(checked(await friend.get(ask)), false);
    const admin = await signIn('admin@seerr.dev');
    assert.equal(checked(await admin.get(ask)), true);
    assert.equal(checked(await admin.get('/api/v1/status')), false);
  });

  it('follows the setting for everyone else, and is skipped when asked', async () => {
    getSettings().main.versionCheck = true;
    assert.equal(checked(await request(app).get('/api/v1/status')), true);
    assert.equal(
      checked(
        await request(app).get('/api/v1/status?checkUpdateAvailable=true')
      ),
      true
    );
    assert.equal(
      checked(
        await request(app).get('/api/v1/status?checkUpdateAvailable=false')
      ),
      false
    );
  });
});

describe('TMDB lookups', () => {
  it('are only for people signed in', async () => {
    for (const path of [
      '/api/v1/studio/1',
      '/api/v1/network/1',
      '/api/v1/keyword/1',
      '/api/v1/watchproviders/regions',
      '/api/v1/watchproviders/movies?watchRegion=US',
      '/api/v1/watchproviders/tv?watchRegion=US',
    ]) {
      const res = await request(app)
        .get(path)
        .set('Cookie', 'connect.sid=s%3Aanything.anything');
      assert.equal(res.status, 403, path);
    }
  });
});

describe('GET /status/appdata', () => {
  afterEach(() => {
    getSettings().public.initialized = false;
  });

  it('gives the data path during setup', async () => {
    getSettings().public.initialized = false;
    const res = await request(app).get('/api/v1/status/appdata');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.appData, 'boolean');
    assert.equal(typeof res.body.appDataPath, 'string');
  });

  it('gives the data path after setup only to admins', async () => {
    getSettings().public.initialized = true;

    const anonymous = await request(app).get('/api/v1/status/appdata');
    assert.equal(anonymous.status, 200);
    assert.equal(typeof anonymous.body.appData, 'boolean');
    assert.equal(anonymous.body.appDataPath, undefined);

    const friend = await (
      await signIn('friend@seerr.dev')
    ).get('/api/v1/status/appdata');
    assert.equal(friend.body.appDataPath, undefined);

    const admin = await (
      await signIn('admin@seerr.dev')
    ).get('/api/v1/status/appdata');
    assert.equal(typeof admin.body.appDataPath, 'string');
  });
});
