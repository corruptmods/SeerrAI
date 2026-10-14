import TheMovieDb from '@server/api/themoviedb';
import { getRepository } from '@server/datasource';
import OverrideRule from '@server/entity/OverrideRule';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import overrideRuleRoutes from '@server/routes/overrideRule';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

/*
 * Upstream's override-rules preview (seerr-team/seerr#2164) needed the
 * /overrideRule mount loosened from admin-only to any signed-in user. That is
 * only safe if every rule-management route still guards itself, so these run
 * through the real validator and check who can reach what.
 */

setupTestDb();

let server: Server;
let port: number;
let actingAs: User;

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async () => ({
      id: 550,
      title: 'Film',
      genres: [],
      keywords: { keywords: [] },
      original_language: 'en',
    });
  },
});

const call = (method: string, route: string, body?: unknown) =>
  new Promise<number>((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });

const makeUser = async (name: string, permissions: number) => {
  await getRepository(User).save(
    new User({
      email: `${name}@test.local`,
      plexUsername: name,
      permissions,
      avatar: '',
    })
  );

  return getRepository(User).findOneOrFail({ where: { plexUsername: name } });
};

let admin: User;
let advanced: User;
let plain: User;

beforeEach(async () => {
  admin = await makeUser('or-admin', Permission.ADMIN);
  advanced = await makeUser(
    'or-advanced',
    Permission.REQUEST | Permission.REQUEST_ADVANCED
  );
  plain = await makeUser('or-plain', Permission.REQUEST);
  actingAs = admin;

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
    app.use('/api/v1/overrideRule', overrideRuleRoutes);
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

const preview = (requestUser?: number) =>
  call('POST', '/api/v1/overrideRule/advancedRequest', {
    mediaType: 'movie',
    tmdbId: 550,
    is4k: false,
    ...(requestUser ? { requestUser } : {}),
  });

describe('override rules after loosening the mount', () => {
  it('still keeps rule management admin only', async () => {
    actingAs = plain;
    assert.equal(await call('GET', '/api/v1/overrideRule'), 403);
    assert.equal(await call('DELETE', '/api/v1/overrideRule/1'), 403);

    actingAs = advanced;
    assert.equal(
      await call('GET', '/api/v1/overrideRule'),
      403,
      'advanced requesting is not rule management'
    );
  });

  it('lets an admin list rules', async () => {
    assert.equal(await call('GET', '/api/v1/overrideRule'), 200);
  });

  it('lets someone with advanced requesting preview their own request', async () => {
    actingAs = advanced;
    assert.equal(await preview(advanced.id), 200);
  });

  it('refuses the preview to someone without advanced requesting', async () => {
    actingAs = plain;
    assert.equal(await preview(plain.id), 403);
  });

  it('refuses a preview for another user without request management', async () => {
    actingAs = advanced;
    assert.equal(await preview(plain.id), 403);
  });
});

describe('an override rule on age ratings', () => {
  const stored = () =>
    getRepository(OverrideRule).findOneOrFail({
      where: { rootFolder: '/kids' },
    });

  it('keeps the ratings it is given, through the API', async () => {
    assert.equal(
      await call('POST', '/api/v1/overrideRule', {
        radarrServiceId: 0,
        certification: ' US:G , US:PG ',
        rootFolder: '/kids',
      }),
      200
    );
    const created = await stored();
    assert.equal(created.certification, 'US:G,US:PG');

    assert.equal(
      await call('PUT', `/api/v1/overrideRule/${created.id}`, {
        radarrServiceId: 0,
        certification: 'GB:U',
        rootFolder: '/kids',
      }),
      200
    );
    assert.equal((await stored()).certification, 'GB:U');
  });

  it('keeps none when none or nothing usable is given', async () => {
    await call('POST', '/api/v1/overrideRule', {
      radarrServiceId: 0,
      certification: '',
      rootFolder: '/kids',
    });
    const created = await stored();
    assert.equal(created.certification, null);

    await call('PUT', `/api/v1/overrideRule/${created.id}`, {
      radarrServiceId: 0,
      certification: 'PG',
      rootFolder: '/kids',
    });
    assert.equal((await stored()).certification, null);
  });
});
