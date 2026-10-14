import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaEvent, MediaEventType } from '@server/entity/MediaEvent';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import requestRoutes from '@server/routes/request';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { after, beforeEach, describe, it, mock } from 'node:test';

/*
 * Declining a request with a reason, through the real OpenAPI validator as
 * in production: a body field the spec does not declare would be refused
 * before it reached the route.
 */

setupTestDb();

let server: Server;
let port: number;
let actingAs: User;

const sendNotification = mock.method(
  MediaRequest,
  'sendNotification',
  async () => true
).mock;

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async () => ({ id: 1, title: 'Film', release_date: '2020-01-01' });
  },
});

/**
 * Posts to the API. `body` undefined sends nothing at all, without a
 * content type, as the Decline button on a push notification does.
 */
const call = <T>(method: string, route: string, body?: unknown) =>
  new Promise<{ status: number; body: T }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : ({} as T),
          })
        );
      }
    );
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });

const makeUser = async (name: string, permissions: number) =>
  getRepository(User).save(
    new User({
      email: `${name}@test.local`,
      plexUsername: name,
      permissions,
      avatar: '',
    })
  );

let requester: User;

const seedPending = async (tmdbId = 603) => {
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
  getRepository(MediaRequest).findOneOrFail({ where: { id } });

beforeEach(async () => {
  sendNotification.resetCalls();
  actingAs = await makeUser('dr-admin', Permission.MANAGE_REQUESTS);
  requester = await makeUser('dr-friend', Permission.REQUEST);

  if (!server) {
    const app = express();
    app.use(express.json());
    app.use(
      OpenApiValidator.middleware({
        apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
        validateRequests: true,
        validateSecurity: false,
      })
    );
    app.use((req, _res, next) => {
      (req as unknown as { user: User }).user = actingAs;
      next();
    });
    app.use('/api/v1/request', requestRoutes);
    app.use(
      (
        err: { status?: number; message: string },
        _req: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: express.NextFunction
      ) => res.status(err.status ?? 500).json({ message: err.message })
    );

    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    port = (server.address() as { port: number }).port;
  }
});

after(() => {
  server?.close();
});

describe('declining a request with a reason', () => {
  it('keeps the reason, trimmed, and returns it', async () => {
    const pending = await seedPending();

    const { status, body } = await call<MediaRequest>(
      'POST',
      `/api/v1/request/${pending.id}/decline`,
      { declineReason: '  Already on Netflix \n' }
    );

    assert.equal(status, 200);
    assert.equal(body.status, MediaRequestStatus.DECLINED);
    assert.equal(body.declineReason, 'Already on Netflix');
    assert.equal(
      (await stored(pending.id)).declineReason,
      'Already on Netflix'
    );
  });

  it('tells the requester why, in the declined notification', async () => {
    const pending = await seedPending();

    await call('POST', `/api/v1/request/${pending.id}/decline`, {
      declineReason: 'Already on Netflix',
    });

    const declined = sendNotification.calls.find(
      (c) => c.arguments[2] === Notification.MEDIA_DECLINED
    );
    assert.ok(declined, 'a declined notification was sent');
    assert.equal(
      (declined.arguments[0] as MediaRequest).declineReason,
      'Already on Netflix'
    );
  });

  it("puts the reason in the title's history", async () => {
    const pending = await seedPending(604);

    await call('POST', `/api/v1/request/${pending.id}/decline`, {
      declineReason: 'Already on Netflix',
    });

    const event = await getRepository(MediaEvent).findOneOrFail({
      where: { tmdbId: 604, type: MediaEventType.DECLINED },
    });
    assert.equal(event.detail, 'Already on Netflix');
  });

  it('declines with no reason when none is given', async () => {
    for (const body of [{}, { declineReason: null }, { declineReason: '  ' }]) {
      const pending = await seedPending();

      const res = await call<MediaRequest>(
        'POST',
        `/api/v1/request/${pending.id}/decline`,
        body
      );

      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal((await stored(pending.id)).declineReason ?? null, null);
      await getRepository(MediaRequest).delete(pending.id);
      await getRepository(Media).delete({ tmdbId: 603 });
    }
  });

  it("declines from a push notification's button, which sends no body", async () => {
    const pending = await seedPending();

    const { status } = await call(
      'POST',
      `/api/v1/request/${pending.id}/decline`
    );

    assert.equal(status, 200);
    const saved = await stored(pending.id);
    assert.equal(saved.status, MediaRequestStatus.DECLINED);
    assert.equal(saved.declineReason ?? null, null);
  });

  it('refuses a reason over 500 characters, and leaves the request waiting', async () => {
    const pending = await seedPending();

    const { status, body } = await call<{ message: string }>(
      'POST',
      `/api/v1/request/${pending.id}/decline`,
      { declineReason: 'x'.repeat(501) }
    );

    assert.equal(status, 400);
    assert.match(body.message, /500/);
    const saved = await stored(pending.id);
    assert.equal(saved.status, MediaRequestStatus.PENDING);
    assert.equal(saved.declineReason ?? null, null);
  });

  it('counts the length after trimming', async () => {
    const pending = await seedPending();

    const { status } = await call(
      'POST',
      `/api/v1/request/${pending.id}/decline`,
      { declineReason: `  ${'x'.repeat(500)}  ` }
    );

    assert.equal(status, 200);
    assert.equal((await stored(pending.id)).declineReason, 'x'.repeat(500));
  });

  it('refuses a reason that is not text', async () => {
    const pending = await seedPending();

    const { status } = await call(
      'POST',
      `/api/v1/request/${pending.id}/decline`,
      { declineReason: { html: '<b>no</b>' } }
    );

    assert.equal(status, 400);
    assert.equal((await stored(pending.id)).status, MediaRequestStatus.PENDING);
  });

  it('keeps no reason when a request is approved', async () => {
    const pending = await seedPending();

    const { status } = await call(
      'POST',
      `/api/v1/request/${pending.id}/approve`,
      { declineReason: 'Not meant for an approval' }
    );

    assert.equal(status, 200);
    assert.equal((await stored(pending.id)).declineReason ?? null, null);
  });
});
