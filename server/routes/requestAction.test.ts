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
import { initI18n } from '@server/i18n';
import { Permission } from '@server/lib/permissions';
import {
  requestFingerprint,
  signActionToken,
} from '@server/lib/requestActionTokens';
import type { RequestAction } from '@server/lib/requestStatusChange';
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
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';
import request from 'supertest';

/*
 * ntfy's Approve and Decline buttons, sent as the ntfy app sends them: no
 * cookie, no CSRF token, only the token in the body. Through the app's own
 * middleware in server/index.ts's order, with CSRF protection on and the API
 * spec checked, security included.
 */

setupTestDb();

mock.method(MediaRequest, 'sendNotification', async () => true);

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async () => ({
      id: 1,
      title: 'Glasswing',
      release_date: '2020-01-01',
    });
  },
});

let app: Express;

before(() => {
  initI18n();
  app = express();
  // Each test counts against its own address.
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

const ntfy = getSettings().notifications.agents.ntfy;
const saved = {
  ntfy: structuredClone(ntfy),
  csrf: getSettings().network.csrfProtection,
};

let address = 0;
let ip = '';
let requester: User;

beforeEach(async () => {
  getSettings().network.csrfProtection = true;
  ntfy.enabled = true;
  ntfy.options.url = 'https://ntfy.example';
  ntfy.options.topic = 'requests';
  ntfy.options.locale = 'en';
  ntfy.options.approvalButtons = true;
  ntfy.options.approveAsUserId = undefined;
  address += 1;
  ip = `203.0.113.${address}`;
  requester = await getRepository(User).save(
    new User({
      email: `lantern${address}@test.local`,
      plexUsername: `lantern${address}`,
      permissions: Permission.REQUEST,
      avatar: '',
    })
  );
});

afterEach(() => {
  Object.assign(ntfy, structuredClone(saved.ntfy));
  getSettings().network.csrfProtection = saved.csrf;
});

after(() => {
  Object.assign(ntfy, saved.ntfy);
});

const seedPending = async (tmdbId = 8101) => {
  const media = await getRepository(Media).save(
    new Media({
      tmdbId,
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

const stored = (id: number) =>
  getRepository(MediaRequest).findOneOrFail({
    where: { id },
    relations: { modifiedBy: true },
  });

/** As the ntfy agent makes it, from the request just saved. */
const tokenFor = (request: MediaRequest, action: RequestAction, userId = 1) =>
  signActionToken({
    requestId: request.id,
    action,
    userId,
    agent: 'ntfy',
    requestState: requestFingerprint(request),
  });

/** As the ntfy app's http action sends it. */
const press = (body: unknown) =>
  request(app)
    .post('/api/v1/request/action')
    .set('X-Forwarded-For', ip)
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(body));

describe('pressing Approve or Decline on ntfy', () => {
  it('approves as the owner, with no session or CSRF token', async () => {
    const pending = await seedPending();

    const res = await press({ token: tokenFor(pending, 'approve') });

    assert.equal(res.status, 200, res.text);
    assert.match(res.headers['content-type'], /^text\/plain/);
    assert.equal(res.text, 'Approved by admin');
    const saved = await stored(pending.id);
    assert.equal(saved.status, MediaRequestStatus.APPROVED);
    assert.equal(saved.modifiedBy?.id, 1);
  });

  it('declines as the account chosen in the ntfy settings', async () => {
    const manager = await getRepository(User).save(
      new User({
        email: 'harbour@test.local',
        plexUsername: 'harbour',
        permissions: Permission.MANAGE_REQUESTS,
        avatar: '',
      })
    );
    ntfy.options.approveAsUserId = manager.id;
    const pending = await seedPending();

    const res = await press({
      token: tokenFor(pending, 'decline', manager.id),
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(res.text, 'Declined by harbour');
    const saved = await stored(pending.id);
    assert.equal(saved.status, MediaRequestStatus.DECLINED);
    assert.equal(saved.modifiedBy?.id, manager.id);
  });

  it('does nothing to a request already handled, and says how it was', async () => {
    const pending = await seedPending();
    const approve = tokenFor(pending, 'approve');
    const decline = tokenFor(pending, 'decline');

    assert.equal((await press({ token: approve })).status, 200);
    const late = await press({ token: decline });

    assert.equal(late.status, 409);
    assert.equal(late.text, 'Already approved');
    assert.equal(
      (await stored(pending.id)).status,
      MediaRequestStatus.APPROVED
    );
  });

  it('works once: the same token sent again does nothing, even if the request is waiting again', async () => {
    const pending = await seedPending();
    const decline = tokenFor(pending, 'decline');

    assert.equal((await press({ token: decline })).status, 200);
    // Edited back to waiting for approval.
    await getRepository(MediaRequest).update(pending.id, {
      status: MediaRequestStatus.PENDING,
    });

    const replay = await press({ token: decline });

    assert.equal(replay.status, 401);
    assert.equal(replay.text, 'This button has expired or no longer works');
    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);
  });

  it('refuses once the account it acts as can no longer manage requests', async () => {
    const manager = await getRepository(User).save(
      new User({
        email: 'static@test.local',
        plexUsername: 'static',
        permissions: Permission.MANAGE_REQUESTS,
        avatar: '',
      })
    );
    ntfy.options.approveAsUserId = manager.id;
    const pending = await seedPending();
    const token = tokenFor(pending, 'approve', manager.id);
    await getRepository(User).update(manager.id, {
      permissions: Permission.REQUEST,
    });

    const res = await press({ token });

    assert.equal(res.status, 403);
    assert.equal(res.text, 'static can no longer manage requests');
    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);
  });

  it('refuses buttons sent before they were turned off, or made for another account', async () => {
    const pending = await seedPending();
    const token = tokenFor(pending, 'approve');

    ntfy.options.approvalButtons = false;
    assert.equal((await press({ token })).status, 401);

    ntfy.options.approvalButtons = true;
    ntfy.options.approveAsUserId = 2;
    assert.equal((await press({ token })).status, 401);

    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);
  });

  it('refuses a wrong, changed or missing token', async () => {
    const pending = await seedPending();
    const [body, signature] = tokenFor(pending, 'approve').split('.');
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString());
    const otherRequest = Buffer.from(
      JSON.stringify({ ...decoded, r: pending.id + 1 })
    ).toString('base64url');

    for (const token of ['nonsense', `${otherRequest}.${signature}`]) {
      const res = await press({ token });
      assert.equal(res.status, 401, token);
    }

    // Refused by the API spec before the route: no token, or something else.
    assert.equal((await press({})).status, 400);
    assert.equal(
      (await press({ token: 'x', requestId: pending.id })).status,
      400
    );
    assert.equal((await press({ token: 'x'.repeat(513) })).status, 400);

    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);
  });

  it('says so for a request that is gone', async () => {
    const res = await press({
      token: tokenFor(
        { id: 999_999, type: MediaType.MOVIE } as MediaRequest,
        'approve'
      ),
    });

    assert.equal(res.status, 404);
    assert.equal(res.text, 'This request no longer exists');
  });

  it('keeps the token out of the address: one in the query string is not read', async () => {
    const pending = await seedPending();
    const token = tokenFor(pending, 'approve');

    const res = await request(app)
      .post(`/api/v1/request/action?token=${encodeURIComponent(token)}`)
      .set('X-Forwarded-For', ip)
      .set('Content-Type', 'application/json')
      .send('{}');

    assert.equal(res.status, 400);
    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);
  });

  it('refuses a button for a request edited since the notification went out', async () => {
    const pending = await seedPending();
    const approve = tokenFor(pending, 'approve');
    await getRepository(MediaRequest).update(pending.id, { is4k: true });

    const res = await press({ token: approve });

    assert.equal(res.status, 409);
    assert.equal(
      res.text,
      'This request changed since; open Seerr AI to review it'
    );
    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);
  });

  it('leaves the button usable when the change could not be saved', async (t) => {
    const pending = await seedPending();
    const approve = tokenFor(pending, 'approve');
    const repository = getRepository(MediaRequest);
    const save = repository.save.bind(repository);
    let failNext = true;
    t.mock.method(repository, 'save', ((...args: Parameters<typeof save>) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('disk full'));
      }
      return save(...args);
    }) as typeof save);

    const failed = await press({ token: approve });
    assert.equal(failed.status, 500);
    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);

    const retried = await press({ token: approve });
    assert.equal(retried.status, 200, retried.text);
    assert.equal(
      (await stored(pending.id)).status,
      MediaRequestStatus.APPROVED
    );
  });

  it('is limited per address', async () => {
    let last = 0;
    for (let i = 0; i < 61; i++) {
      last = (await press({ token: 'nonsense' })).status;
    }
    assert.equal(last, 429);
    const limited = await press({ token: 'nonsense' });
    assert.match(limited.headers['content-type'], /^text\/plain/);

    // Another address is not held up.
    ip = '203.0.113.250';
    assert.equal((await press({ token: 'nonsense' })).status, 401);
  });
});

describe('CSRF protection with the ntfy buttons', () => {
  it('is skipped for exactly this route', async () => {
    // Another change with no token is still refused.
    const other = await request(app)
      .post('/api/v1/request/1/approve')
      .set('X-Forwarded-For', ip)
      .send({});
    assert.equal(other.status, 403);
    assert.match(other.body.message, /csrf token/i);

    // A GET to the same path is not this route either.
    const get = await request(app)
      .get('/api/v1/request/action')
      .set('X-Forwarded-For', ip);
    assert.notEqual(get.status, 200);
  });
});
