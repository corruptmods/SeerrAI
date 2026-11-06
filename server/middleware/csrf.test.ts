import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it } from 'node:test';

import { getRepository } from '@server/datasource';
import UserApiKey from '@server/entity/UserApiKey';
import {
  makeKey,
  resetApiKeyMemoryForTests,
} from '@server/lib/personalApiKeys';
import { getSettings } from '@server/lib/settings';
import { unlessApiKey } from '@server/middleware/auth';
import { csrfWhileOn } from '@server/middleware/csrf';
import { jsonBody } from '@server/middleware/jsonBody';
import routes from '@server/routes';
import { setupTestDb } from '@server/test/db';
import cookieParser from 'cookie-parser';
import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import path from 'node:path';
import request from 'supertest';

// Settings → Network → CSRF Protection with API keys. An API key request
// carries no cookie another site could ride, so it needs no CSRF token; and it
// belongs to the key alone, so a wrong key is rejected rather than served as
// whoever's session cookie came along. Cookie-authenticated requests keep the
// full check.
//
// The app is assembled in the same order as server/index.ts.

let app: Express;

function createApp() {
  const app = express();
  // Each test's wrong keys count against its own address.
  app.set('trust proxy', true);
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
        cookie: { httpOnly: true, sameSite: 'strict' },
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
  return app;
}

before(() => {
  app = createApp();
});

setupTestDb();

const settingsBefore = {
  csrfProtection: getSettings().network.csrfProtection,
  personalApiKeys: getSettings().main.personalApiKeys,
  localLogin: getSettings().main.localLogin,
  serverKey: getSettings().main.apiKey,
};

let address = 0;
let ip = '';
beforeEach(() => {
  resetApiKeyMemoryForTests();
  getSettings().network.csrfProtection = true;
  getSettings().main.personalApiKeys = 'everyone';
  getSettings().main.localLogin = true;
  // Real servers always have one.
  getSettings().main.apiKey = 'the-servers-own-key';
  address += 1;
  ip = `198.51.100.${address}`;
});

afterEach(() => {
  getSettings().network.csrfProtection = settingsBefore.csrfProtection;
  getSettings().main.personalApiKeys = settingsBefore.personalApiKeys;
  getSettings().main.localLogin = settingsBefore.localLogin;
  getSettings().main.apiKey = settingsBefore.serverKey;
});

/** A harmless change only an admin may make. */
const CHANGE = '/api/v1/settings/main';

/** The token the browser gets, read back as the page reads it. */
function tokenFrom(res: request.Response): string {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith('XSRF-TOKEN='));
  assert.ok(cookie, 'the XSRF-TOKEN cookie is given out');
  return decodeURIComponent(cookie.split(';')[0].split('=')[1]);
}

/** A browser signed in with a password, and its CSRF token. */
async function signIn(email: string) {
  const agent = request.agent(app);
  const first = await agent.get('/api/v1/status').set('X-Forwarded-For', ip);
  const token = tokenFrom(first);
  const res = await agent
    .post('/api/v1/auth/local')
    .set('X-Forwarded-For', ip)
    .set('X-XSRF-TOKEN', token)
    .send({ email, password: 'test1234' });
  assert.equal(res.status, 200, res.body.message);
  return { agent, token };
}

/** A personal key for this user, made as their profile makes one. */
async function personalKey(userId: number): Promise<string> {
  const { key, publicId, secretHash } = makeKey();
  await getRepository(UserApiKey).insert({
    userId,
    publicId,
    secretHash,
    name: 'Script',
  });
  return key;
}

describe('a change made with an API key', () => {
  it("is taken with the server's key, without a CSRF token", async () => {
    const res = await request(app)
      .post(CHANGE)
      .set('X-Forwarded-For', ip)
      .set('X-Api-Key', getSettings().main.apiKey)
      .send({});
    assert.equal(res.status, 200, res.body.message);
  });

  it('is taken with a personal key, without a CSRF token', async () => {
    const key = await personalKey(1);
    const res = await request(app)
      .post(CHANGE)
      .set('X-Forwarded-For', ip)
      .set('X-Api-Key', key)
      .send({});
    assert.equal(res.status, 200, res.body.message);
  });

  it("acts only as the key's owner, with exactly their permissions", async () => {
    const key = await personalKey(2);
    const res = await request(app)
      .post(CHANGE)
      .set('X-Forwarded-For', ip)
      .set('X-Api-Key', key)
      .send({});
    assert.equal(res.status, 403);
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('X-Forwarded-For', ip)
      .set('X-Api-Key', key);
    assert.equal(me.body.id, 2);
  });
});

describe('a wrong API key', () => {
  const wrongKeys = {
    "a wrong server's key": () => 'not-the-servers-key',
    'an empty one': () => '',
    'a revoked personal key': async () => {
      const key = await personalKey(1);
      await getRepository(UserApiKey).delete({ userId: 1 });
      return key;
    },
  };

  for (const [name, wrongKey] of Object.entries(wrongKeys)) {
    it(`is refused, ${name}, even with an admin's session cookie and its token`, async () => {
      const { agent, token } = await signIn('admin@seerr.dev');
      const key = await wrongKey();

      const me = await agent
        .get('/api/v1/auth/me')
        .set('X-Forwarded-For', ip)
        .set('X-Api-Key', key);
      assert.equal(me.status, 401);

      // With or without the token, the cookie is never used.
      for (const withToken of [false, true]) {
        const change = agent
          .post(CHANGE)
          .set('X-Forwarded-For', ip)
          .set('X-Api-Key', key);
        if (withToken) {
          change.set('X-XSRF-TOKEN', token);
        }
        const res = await change.send({});
        assert.equal(res.status, 401, `with token: ${withToken}`);
      }

      // The browser session itself is still signed in.
      const still = await agent
        .get('/api/v1/auth/me')
        .set('X-Forwarded-For', ip);
      assert.equal(still.body.id, 1);
    });
  }
});

describe('a request with a key and a session cookie', () => {
  it('leaves the session alone: signing out with a key signs no one out', async () => {
    const { agent } = await signIn('admin@seerr.dev');
    const out = await agent
      .post('/api/v1/auth/logout')
      .set('X-Forwarded-For', ip)
      .set('X-Api-Key', getSettings().main.apiKey);
    assert.equal(out.status, 200);
    const still = await agent.get('/api/v1/auth/me').set('X-Forwarded-For', ip);
    assert.equal(still.body.id, 1);
  });

  it('has no session, so passkeys are refused plainly rather than failing', async () => {
    const asKey = (url: string) =>
      request(app)
        .post(url)
        .set('X-Forwarded-For', ip)
        .set('X-Api-Key', getSettings().main.apiKey)
        .send({});
    const options = await asKey('/api/v1/auth/passkey/register/options');
    assert.ok(options.status < 500, options.body.message);
    const register = await asKey('/api/v1/auth/passkey/register');
    assert.equal(register.status, 400);
    const login = await asKey('/api/v1/auth/passkey/login/options');
    assert.ok(login.status < 500, login.body.message);
  });
});

describe('a change made with the session cookie', () => {
  it('still needs the CSRF token', async () => {
    const { agent, token } = await signIn('admin@seerr.dev');
    const without = await agent
      .post(CHANGE)
      .set('X-Forwarded-For', ip)
      .send({});
    assert.equal(without.status, 403);
    const wrong = await agent
      .post(CHANGE)
      .set('X-Forwarded-For', ip)
      .set('X-XSRF-TOKEN', 'not-the-token')
      .send({});
    assert.equal(wrong.status, 403);
    const res = await agent
      .post(CHANGE)
      .set('X-Forwarded-For', ip)
      .set('X-XSRF-TOKEN', token)
      .send({});
    assert.equal(res.status, 200, res.body.message);
  });

  it("still needs the token with the server's key in the address", async () => {
    // Keys are only read from the X-Api-Key header, never the URL.
    const { agent } = await signIn('admin@seerr.dev');
    const res = await agent
      .post(`${CHANGE}?apiKey=${getSettings().main.apiKey}`)
      .set('X-Forwarded-For', ip)
      .send({});
    assert.equal(res.status, 403);
  });
});

describe('with CSRF Protection off', () => {
  it('a wrong key is refused all the same, never served as the session', async () => {
    const plain = express();
    plain.set('trust proxy', true);
    plain.use(express.json());
    plain.use(
      '/api',
      session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
      })
    );
    plain.use('/api/v1', routes);
    const agent = request.agent(plain);
    const signedIn = await agent
      .post('/api/v1/auth/local')
      .set('X-Forwarded-For', ip)
      .send({ email: 'admin@seerr.dev', password: 'test1234' });
    assert.equal(signedIn.status, 200);
    const res = await agent
      .get('/api/v1/auth/me')
      .set('X-Forwarded-For', ip)
      .set('X-Api-Key', 'not-the-servers-key');
    assert.equal(res.status, 401);
  });
});

describe('CSRF protection turned on or off while running', () => {
  it('checks changes from the next request on, with no restart', async () => {
    const { agent } = await signIn('admin@seerr.dev');
    const change = () => agent.post(CHANGE).set('X-Forwarded-For', ip).send({});

    getSettings().network.csrfProtection = false;
    assert.equal((await change()).status, 200);

    getSettings().network.csrfProtection = true;
    const refused = await change();
    assert.equal(refused.status, 403);
    assert.match(refused.body.message, /csrf token/i);

    // Any page load gives a token again.
    const token = tokenFrom(
      await agent.get('/api/v1/status').set('X-Forwarded-For', ip)
    );
    const retried = await agent
      .post(CHANGE)
      .set('X-Forwarded-For', ip)
      .set('X-XSRF-TOKEN', token)
      .send({});
    assert.equal(retried.status, 200, retried.body.message);
  });
});
