import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
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
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';

/*
 * A web push notification's Approve and Decline, as public/sw.js sends them:
 * the session cookie, no body, and the XSRF-TOKEN cookie's value in
 * X-XSRF-TOKEN when it can read one (after any GET if it had none). Through
 * the app's middleware in server/index.ts's order, with CSRF Protection on and
 * off as it can be switched while running.
 */

setupTestDb();

mock.method(MediaRequest, 'sendNotification', async () => true);

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async () => ({
      id: 1,
      title: 'Static Garden',
      release_date: '2020-01-01',
    });
  },
});

let app: Express;

before(() => {
  app = express();
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

const saved = {
  csrf: getSettings().network.csrfProtection,
  localLogin: getSettings().main.localLogin,
};

let address = 0;
let ip = '';

beforeEach(() => {
  getSettings().main.localLogin = true;
  address += 1;
  ip = `198.51.100.${address}`;
});

afterEach(() => {
  getSettings().network.csrfProtection = saved.csrf;
  getSettings().main.localLogin = saved.localLogin;
});

const seedPending = async () => {
  const requester = await getRepository(User).findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });
  const media = await getRepository(Media).save(
    new Media({
      tmdbId: 8201,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.PENDING,
    })
  );
  return getRepository(MediaRequest).save(
    new MediaRequest({
      media,
      requestedBy: requester,
      type: MediaType.MOVIE,
      status: MediaRequestStatus.PENDING,
      is4k: false,
    })
  );
};

const statusOf = async (id: number) =>
  (await getRepository(MediaRequest).findOneByOrFail({ id })).status;

/** The XSRF-TOKEN cookie a response set, as cookieStore would read it. */
const tokenFrom = (res: request.Response): string | undefined => {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith('XSRF-TOKEN='));
  return cookie
    ? decodeURIComponent(cookie.split(';')[0].split('=')[1])
    : undefined;
};

/** A browser signed in, and the last CSRF token it was given. */
const signIn = async (email: string) => {
  const agent = request.agent(app);
  const first = await agent.get('/api/v1/status').set('X-Forwarded-For', ip);
  const token = tokenFrom(first);
  const signedIn = agent.post('/api/v1/auth/local').set('X-Forwarded-For', ip);
  if (token) {
    signedIn.set('X-XSRF-TOKEN', token);
  }
  const res = await signedIn.send({ email, password: 'test1234' });
  assert.equal(res.status, 200, res.body.message);
  return { agent, token: tokenFrom(res) ?? token };
};

/** The worker's POST: no body, the token header only when it has one. */
const tap = (
  agent: ReturnType<typeof request.agent>,
  requestId: number,
  action: 'approve' | 'decline',
  token: string | undefined
) => {
  const post = agent
    .post(`/api/v1/request/${requestId}/${action}`)
    .set('X-Forwarded-For', ip);
  return token ? post.set('X-XSRF-TOKEN', token) : post;
};

describe('approving from a web push notification', () => {
  it('works with CSRF Protection on, sending the token cookie’s value', async () => {
    getSettings().network.csrfProtection = true;
    const { agent, token } = await signIn('admin@seerr.dev');
    const pending = await seedPending();

    const res = await tap(agent, pending.id, 'approve', token);

    assert.equal(res.status, 200, res.body.message);
    assert.equal(await statusOf(pending.id), MediaRequestStatus.APPROVED);
  });

  it('works with CSRF Protection turned on after the worker last saw a token', async () => {
    getSettings().network.csrfProtection = false;
    const { agent, token } = await signIn('admin@seerr.dev');
    assert.equal(token, undefined, 'no token is given while it is off');
    const pending = await seedPending();

    getSettings().network.csrfProtection = true;
    // The worker finds no cookie, so it fetches the count first.
    const count = await agent
      .get('/api/v1/request/count')
      .set('X-Forwarded-For', ip);
    const fresh = tokenFrom(count);
    assert.ok(fresh, 'the count gives a token');

    const res = await tap(agent, pending.id, 'decline', fresh);

    assert.equal(res.status, 200, res.body.message);
    assert.equal(await statusOf(pending.id), MediaRequestStatus.DECLINED);
  });

  it('works with CSRF Protection off, with or without a leftover token', async () => {
    getSettings().network.csrfProtection = true;
    const { agent, token } = await signIn('admin@seerr.dev');
    getSettings().network.csrfProtection = false;

    const first = await seedPending();
    assert.equal((await tap(agent, first.id, 'approve', token)).status, 200);
    await getRepository(MediaRequest).delete(first.id);
    await getRepository(Media).delete({ tmdbId: 8201 });

    const second = await seedPending();
    assert.equal(
      (await tap(agent, second.id, 'approve', undefined)).status,
      200
    );
  });

  it('is refused with CSRF Protection on where the worker can read no cookie', async () => {
    // Browsers without cookieStore in workers: the app links to the request
    // instead (the failure notification).
    getSettings().network.csrfProtection = true;
    const { agent } = await signIn('admin@seerr.dev');
    const pending = await seedPending();

    const res = await tap(agent, pending.id, 'approve', undefined);

    assert.equal(res.status, 403);
    assert.equal(await statusOf(pending.id), MediaRequestStatus.PENDING);
  });

  it('needs permission to manage requests, CSRF token or not', async () => {
    for (const csrf of [true, false]) {
      getSettings().network.csrfProtection = csrf;
      const { agent, token } = await signIn('friend@seerr.dev');
      const pending = await seedPending();

      const res = await tap(agent, pending.id, 'approve', token);

      assert.equal(res.status, 403, `CSRF Protection ${csrf ? 'on' : 'off'}`);
      assert.equal(await statusOf(pending.id), MediaRequestStatus.PENDING);
      await getRepository(MediaRequest).delete(pending.id);
      await getRepository(Media).delete({ tmdbId: 8201 });
    }
  });
});
