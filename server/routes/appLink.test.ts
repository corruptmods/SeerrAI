import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import UserApiKey from '@server/entity/UserApiKey';
import { resetAppLinksForTests, sweepAppLinks } from '@server/lib/appLinks';
import { resetApiKeyMemoryForTests } from '@server/lib/personalApiKeys';
import { getSettings } from '@server/lib/settings';
import apiPathCase from '@server/middleware/apiPathCase';
import { unlessApiKey } from '@server/middleware/auth';
import { browserAppsCors } from '@server/middleware/browserApps';
import { csrfWhileOn } from '@server/middleware/csrf';
import { jsonBody } from '@server/middleware/jsonBody';
import routes from '@server/routes';
import { setupTestDb } from '@server/test/db';
import cookieParser from 'cookie-parser';
import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

/*
 * Browser apps (Settings → Network) end to end: the cross-site headers, the
 * server's key refused from their sites, and linking an app with a code,
 * through the app's own middleware in server/index.ts's order with the API
 * spec checked.
 */

setupTestDb();

const PLUET = 'https://watch.pluet.app';
const ELSEWHERE = 'https://glasswing.example';

let app: Express;

before(() => {
  app = express();
  // Each test counts against its own address.
  app.set('trust proxy', true);
  app.use(apiPathCase);
  app.use('/api/v1', browserAppsCors);
  app.use(cookieParser());
  app.use(jsonBody);
  app.use(express.urlencoded({ extended: true }));
  app.use(csrfWhileOn());
  app.use(
    '/api',
    unlessApiKey(
      session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
      })
    )
  );
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
    })
  );
  app.use('/api/v1', routes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: Request,
      res: Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: NextFunction
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );
});

const saved = structuredClone({
  network: getSettings().network,
  main: getSettings().main,
});

let address = 0;
let ip = '';

beforeEach(() => {
  address += 1;
  ip = `203.0.113.${address}`;
  const settings = getSettings();
  settings.network.csrfProtection = false;
  settings.network.browserApps = { enabled: true, origins: [PLUET] };
  settings.main.localLogin = true;
  settings.main.personalApiKeys = 'off';
  settings.main.applicationUrl = '';
  resetAppLinksForTests();
  resetApiKeyMemoryForTests();
});

afterEach(() => {
  const settings = getSettings();
  settings.network = structuredClone(saved.network);
  Object.assign(settings.main, structuredClone(saved.main));
});

const signIn = async (email: string) => {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/local')
    .set('X-Forwarded-For', ip)
    .send({ email, password: 'test1234' });
  assert.equal(res.status, 200);
  return { agent, id: res.body.id as number };
};

/** Starts a link from Pluet's site and approves it as `email`. */
const linked = async (email = 'friend@seerr.dev') => {
  const started = await request(app)
    .post('/api/v1/auth/app-link')
    .set('Origin', PLUET)
    .set('X-Forwarded-For', ip)
    .send({ app: 'Pluet' });
  assert.equal(started.status, 201);
  const person = await signIn(email);
  const approved = await person.agent
    .post('/api/v1/auth/app-link/approve')
    .set('X-Forwarded-For', ip)
    .send({ code: started.body.code });
  assert.equal(approved.status, 200);
  const collected = await request(app)
    .get(`/api/v1/auth/app-link/${started.body.linkId}`)
    .set('Origin', PLUET)
    .set('X-Forwarded-For', ip);
  assert.equal(collected.status, 200);
  assert.equal(collected.body.status, 'approved');
  return { key: collected.body.apiKey as string, person, started };
};

const me = (key: string, origin?: string) => {
  const call = request(app)
    .get('/api/v1/auth/me')
    .set('X-Api-Key', key)
    .set('X-Forwarded-For', ip);
  return origin ? call.set('Origin', origin) : call;
};

describe('answers to other sites', () => {
  it('carry nothing while browser apps are off', async () => {
    getSettings().network.browserApps.enabled = false;
    const { key } = await linkedWhileOn();
    getSettings().network.browserApps.enabled = false;
    const res = await me(key, PLUET);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers.vary, undefined);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, {
      status: 401,
      message: 'Browser apps are turned off on this server.',
    });
  });

  it('let an allowed site read a keyed answer, and never with cookies', async () => {
    const { key, person } = await linked();
    const res = await me(key, PLUET);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, person.id);
    assert.equal(res.headers['access-control-allow-origin'], PLUET);
    assert.match(res.headers.vary ?? '', /Origin/);
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
    assert.equal(res.headers['access-control-expose-headers'], 'Retry-After');
  });

  it('let no other site read anything', async () => {
    const { key } = await linked();
    const res = await me(key, ELSEWHERE);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, {
      status: 403,
      message: 'This key only works in the browser app it was linked to.',
    });
  });

  it('answer a preflight from an allowed site without signing in', async () => {
    const res = await request(app)
      .options('/api/v1/request')
      .set('Origin', PLUET)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-api-key, content-type');
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], PLUET);
    assert.equal(
      res.headers['access-control-allow-methods'],
      'GET, POST, PUT, DELETE'
    );
    assert.equal(
      res.headers['access-control-allow-headers'],
      'X-Api-Key, Content-Type'
    );
    assert.equal(res.headers['access-control-max-age'], '600');
    assert.equal(res.headers['access-control-allow-credentials'], undefined);

    const other = await request(app)
      .options('/api/v1/request')
      .set('Origin', ELSEWHERE)
      .set('Access-Control-Request-Method', 'POST');
    assert.equal(other.headers['access-control-allow-origin'], undefined);
  });

  it('carry nothing for a request with only a cookie, even from an allowed site', async () => {
    const { agent } = await signIn('friend@seerr.dev');
    const res = await agent
      .get('/api/v1/auth/me')
      .set('Origin', PLUET)
      .set('X-Forwarded-For', ip);
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  it('tell an allowed site, and only it, that it may link', async () => {
    const res = await request(app)
      .get('/api/v1/status?checkUpdateAvailable=false')
      .set('Origin', PLUET);
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], PLUET);
    assert.equal(res.body.browserAccess, true);
    assert.equal(res.body.appLink, true);

    for (const origin of [ELSEWHERE, undefined]) {
      const call = request(app).get(
        '/api/v1/status?checkUpdateAvailable=false'
      );
      const other = await (origin ? call.set('Origin', origin) : call);
      assert.equal(other.body.browserAccess, undefined);
      assert.equal(other.body.appLink, undefined);
      assert.equal(other.headers['access-control-allow-origin'], undefined);
    }
  });
});

/** As `linked`, for a test that then turns browser apps off. */
const linkedWhileOn = async () => {
  getSettings().network.browserApps.enabled = true;
  return linked();
};

describe('the server’s API key', () => {
  it('is refused from an allowed site, and still works elsewhere', async () => {
    const serverKey = 'c2VydmVyLWtleS1mb3ItdGVzdHM';
    getSettings().main.apiKey = serverKey;
    const fromPluet = await me(serverKey, PLUET);
    assert.equal(fromPluet.status, 403);
    assert.deepEqual(fromPluet.body, {
      status: 403,
      message:
        'The server’s API key can’t be used from a browser app. Link the app to your account instead.',
    });
    assert.equal((await me(serverKey)).status, 200);
    assert.equal((await me(serverKey, ELSEWHERE)).status, 200);

    getSettings().network.browserApps.enabled = false;
    assert.equal((await me(serverKey, PLUET)).status, 200);
  });
});

describe('linking a browser app', () => {
  it('hands its key over once, acting as whoever approved it', async () => {
    const { key, person, started } = await linked();
    assert.match(started.body.code, /^[2-9A-Z]{3}-[2-9A-Z]{3}$/);
    assert.equal(started.body.expiresIn, 600);
    assert.match(key, /^sai_[0-9a-f]{8}_/);

    const again = await request(app)
      .get(`/api/v1/auth/app-link/${started.body.linkId}`)
      .set('Origin', PLUET)
      .set('X-Forwarded-For', ip);
    assert.equal(again.status, 404);

    // Not from anywhere but a browser app's site: no Origin, no use.
    const bare = await me(key);
    assert.equal(bare.status, 403);

    const keys = await person.agent
      .get(`/api/v1/user/${person.id}/settings/api-keys`)
      .set('X-Forwarded-For', ip);
    assert.equal(keys.status, 200);
    assert.equal(keys.body.keys.length, 1);
    assert.equal(keys.body.keys[0].name, 'Pluet (watch.pluet.app)');
    assert.equal(keys.body.keys[0].browser, true);
    assert.equal(keys.body.status, 'off', 'personal keys stay off');
    const stored = await getRepository(UserApiKey).findOneByOrFail({
      id: keys.body.keys[0].id,
    });
    const days =
      (stored.expiresAt!.getTime() - stored.createdAt.getTime()) / 86_400_000;
    assert.equal(Math.round(days), 365);

    const revoked = await person.agent
      .delete(`/api/v1/user/${person.id}/settings/api-keys/${stored.id}`)
      .set('X-Forwarded-For', ip);
    assert.equal(revoked.status, 204);
    assert.equal((await me(key, PLUET)).status, 401);
  });

  it('shows its person the app and site, and waits until they answer', async () => {
    const started = await request(app)
      .post('/api/v1/auth/app-link')
      .set('Origin', PLUET)
      .set('X-Forwarded-For', ip)
      .send({ app: '  Pluet\u0000 in   the browser and a very long name ' });
    const person = await signIn('friend@seerr.dev');
    const checked = await person.agent
      .post('/api/v1/auth/app-link/check')
      .set('X-Forwarded-For', ip)
      .send({ code: started.body.code.toLowerCase().replace('-', ' ') });
    assert.equal(checked.status, 200);
    assert.equal(checked.body.app, 'Pluet in the browser and a very');
    assert.equal(checked.body.site, 'watch.pluet.app');
    assert.equal(checked.body.origin, PLUET);

    const waiting = await request(app)
      .get(`/api/v1/auth/app-link/${started.body.linkId}`)
      .set('Origin', PLUET)
      .set('X-Forwarded-For', ip);
    assert.equal(waiting.body.status, 'waiting');
    assert.equal(waiting.headers['access-control-allow-origin'], PLUET);

    const declined = await person.agent
      .post('/api/v1/auth/app-link/decline')
      .set('X-Forwarded-For', ip)
      .send({ code: started.body.code });
    assert.equal(declined.status, 204);
    const told = await request(app)
      .get(`/api/v1/auth/app-link/${started.body.linkId}`)
      .set('Origin', PLUET)
      .set('X-Forwarded-For', ip);
    assert.deepEqual(told.body, { status: 'declined' });
    assert.equal(
      await getRepository(UserApiKey).countBy({ scope: 'browser' }),
      0
    );
  });

  it('is only waited on from the site that started it', async () => {
    getSettings().network.browserApps.origins = [PLUET, ELSEWHERE];
    const started = await request(app)
      .post('/api/v1/auth/app-link')
      .set('Origin', PLUET)
      .set('X-Forwarded-For', ip)
      .send({ app: 'Pluet' });
    const res = await request(app)
      .get(`/api/v1/auth/app-link/${started.body.linkId}`)
      .set('Origin', ELSEWHERE)
      .set('X-Forwarded-For', ip);
    assert.equal(res.status, 404);
  });

  it('is refused while browser apps are off, or from a site not allowed', async () => {
    const start = (origin: string) =>
      request(app)
        .post('/api/v1/auth/app-link')
        .set('Origin', origin)
        .set('X-Forwarded-For', ip)
        .send({ app: 'Pluet' });
    const other = await start(ELSEWHERE);
    assert.equal(other.status, 403);
    assert.deepEqual(other.body, {
      message: 'This site isn’t allowed to link with this server.',
    });
    getSettings().network.browserApps.enabled = false;
    const off = await start(PLUET);
    assert.equal(off.status, 403);
    assert.deepEqual(off.body, {
      message: 'Browser apps are turned off on this server.',
    });
  });

  it('starts with CSRF protection on, and offers the page to enter the code', async () => {
    getSettings().network.csrfProtection = true;
    getSettings().main.applicationUrl = 'https://seerr.example/';
    const res = await request(app)
      .post('/api/v1/auth/app-link')
      .set('Origin', PLUET)
      .set('X-Forwarded-For', ip)
      .send({ app: 'Pluet' });
    assert.equal(res.status, 201);
    assert.equal(
      res.body.url,
      `https://seerr.example/link?code=${res.body.code.replace('-', '')}`
    );
  });

  it('is approved only while signed in, not with a key', async () => {
    const { key } = await linked();
    const started = await request(app)
      .post('/api/v1/auth/app-link')
      .set('Origin', PLUET)
      .set('X-Forwarded-For', ip)
      .send({ app: 'Pluet' });
    const res = await request(app)
      .post('/api/v1/auth/app-link/approve')
      .set('Origin', PLUET)
      .set('X-Api-Key', key)
      .set('X-Forwarded-For', ip)
      .send({ code: started.body.code });
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, {
      message: 'Link apps while signed in, not with an API key.',
    });
  });

  it('says so for a code nobody started', async () => {
    const { agent } = await signIn('friend@seerr.dev');
    const res = await agent
      .post('/api/v1/auth/app-link/check')
      .set('X-Forwarded-For', ip)
      .send({ code: 'AAA-AAA' });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, {
      message: 'No link has that code. Check it, or start again in the app.',
    });
  });

  it('deletes a key its app never collected', async () => {
    const started = await request(app)
      .post('/api/v1/auth/app-link')
      .set('Origin', PLUET)
      .set('X-Forwarded-For', ip)
      .send({ app: 'Pluet' });
    const { agent } = await signIn('friend@seerr.dev');
    await agent
      .post('/api/v1/auth/app-link/approve')
      .set('X-Forwarded-For', ip)
      .send({ code: started.body.code });
    const keyIds = sweepAppLinks(Date.now() + 60 * 60 * 1000);
    assert.equal(keyIds.length, 1);
  });

  it('stops working once its site is no longer allowed', async () => {
    const { key } = await linked();
    getSettings().network.browserApps.origins = [ELSEWHERE];
    const res = await me(key, PLUET);
    assert.equal(res.status, 403);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });
});

describe('the sites allowed', () => {
  const save = async (body: object) => {
    const { agent } = await signIn('admin@seerr.dev');
    return agent
      .post('/api/v1/settings/network')
      .set('X-Forwarded-For', ip)
      .send(body);
  };

  it('are kept as exact addresses, each once', async () => {
    const res = await save({
      browserApps: {
        enabled: true,
        origins: [
          'https://Watch.Pluet.app/',
          ' https://watch.pluet.app ',
          'http://192.168.1.20:8080',
        ],
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(getSettings().network.browserApps, {
      enabled: true,
      origins: [PLUET, 'http://192.168.1.20:8080'],
    });

    // Left as saved when not sent.
    await save({ browserApps: { enabled: false } });
    assert.deepEqual(getSettings().network.browserApps.origins, [
      PLUET,
      'http://192.168.1.20:8080',
    ]);
    await save({ csrfProtection: false });
    assert.equal(getSettings().network.browserApps.enabled, false);
  });

  it('refuse wildcards, paths and anything not a site', async () => {
    for (const entry of [
      'https://*.pluet.app',
      '*',
      'null',
      'https://watch.pluet.app/app',
      'ftp://watch.pluet.app',
      'https://user@watch.pluet.app',
      'watch.pluet.app',
    ]) {
      const res = await save({
        browserApps: { enabled: true, origins: [PLUET, entry] },
      });
      assert.equal(res.status, 400, entry);
      assert.equal(res.body.invalidOrigin, entry);
    }
    assert.deepEqual(getSettings().network.browserApps.origins, [PLUET]);
  });
});

describe('the people who use a browser app', () => {
  it('act only as themselves, with their own permissions', async () => {
    const friend = await getRepository(User).findOneByOrFail({
      email: 'friend@seerr.dev',
    });
    const { key } = await linked();
    const settings = await request(app)
      .get('/api/v1/settings/main')
      .set('Origin', PLUET)
      .set('X-Api-Key', key)
      .set('X-Forwarded-For', ip);
    assert.equal(settings.status, 403);
    const asSomeoneElse = await me(key, PLUET).set('X-API-User', '1');
    assert.equal(asSomeoneElse.status, 403);
    assert.equal((await me(key, PLUET)).body.id, friend.id);
  });
});
