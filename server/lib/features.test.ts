import TheMovieDb from '@server/api/themoviedb';
import { featureOn } from '@server/constants/features';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { featureEnabled } from '@server/lib/features';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { isAuthenticated } from '@server/middleware/auth';
import discoverRoutes from '@server/routes/discover';
import listRoutes from '@server/routes/list';
import maintainerrRoutes from '@server/routes/maintainerr';
import settingsRoutes from '@server/routes/settings';
import tvRoutes from '@server/routes/tv';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * The optional-feature switches: an admin's for everyone, each person's for
 * themselves, and what the server stops doing when one is off. Through the
 * real API validator and route guards.
 */

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  configurable: true,
  set() {},
  get() {
    return async ({ tvId }: { tvId: number }) => ({
      id: tvId,
      status: 'Returning Series',
      seasons: [{ season_number: 1, air_date: '2020-01-01' }],
    });
  },
});

setupTestDb();

let app: Server;
let port: number;
let signedIn = 'admin@seerr.dev';

before(async () => {
  const ex = express();
  ex.use(express.json());
  ex.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  ex.use(async (req, _res, next) => {
    (req as unknown as { user: User }).user = await getRepository(
      User
    ).findOneOrFail({ where: { email: signedIn } });
    next();
  });
  ex.use('/api/v1/settings', isAuthenticated(Permission.ADMIN), settingsRoutes);
  ex.use('/api/v1/user', isAuthenticated(), userRoutes);
  ex.use('/api/v1/discover', discoverRoutes);
  ex.use('/api/v1/tv', tvRoutes);
  ex.use('/api/v1/list', listRoutes);
  ex.use('/api/v1/maintainerr', maintainerrRoutes);
  ex.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // Express knows an error handler by its four parameters.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );
  app = await new Promise<Server>((resolve) => {
    const s = ex.listen(0, () => resolve(s));
  });
  port = (app.address() as { port: number }).port;
});
after(() => app?.close());
beforeEach(() => {
  signedIn = 'admin@seerr.dev';
  getSettings().main.disabledFeatures = [];
});

const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};

const userId = async (email: string) =>
  (await getRepository(User).findOneOrFail({ where: { email } })).id;

describe('feature switches', () => {
  it('are on unless turned off everywhere or by the person', () => {
    assert.equal(featureOn('deletingSoon', [], []), true);
    assert.equal(featureOn('deletingSoon', ['deletingSoon'], []), false);
    assert.equal(featureOn('deletingSoon', [], ['deletingSoon']), false);
    assert.equal(featureOn('deletingSoon', undefined, undefined), true);
  });

  it('lets an admin turn features off for everyone, ignoring unknown names', async () => {
    const saved = await call('POST', '/settings/features', {
      disabled: ['deletingSoon', 'notAFeature', 'suggestedForYou'],
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.disabled, ['suggestedForYou', 'deletingSoon']);
    assert.deepEqual((await call('GET', '/settings/features')).body, {
      disabled: ['suggestedForYou', 'deletingSoon'],
    });
    assert.equal(featureEnabled('deletingSoon'), false);

    // Replaced as a whole: turning one back on removes it from the list.
    await call('POST', '/settings/features', { disabled: ['deletingSoon'] });
    assert.equal(featureEnabled('suggestedForYou'), true);
  });

  it('keeps the everyone switches to admins', async () => {
    signedIn = 'friend@seerr.dev';
    assert.equal(
      (await call('POST', '/settings/features', { disabled: [] })).status,
      403
    );
  });

  it('lets someone turn features off for themselves only', async () => {
    signedIn = 'friend@seerr.dev';
    const friend = await userId('friend@seerr.dev');
    const saved = await call('POST', `/user/${friend}/settings/features`, {
      disabled: ['passkeyPrompt'],
    });
    assert.equal(saved.status, 200);

    const settings = await getRepository(UserSettings).findOneOrFail({
      where: { user: { id: friend } },
    });
    assert.deepEqual(settings.disabledFeatures, ['passkeyPrompt']);
    assert.deepEqual(
      (await call('GET', `/user/${friend}/settings/features`)).body,
      { disabled: ['passkeyPrompt'] }
    );

    const admin = await userId('admin@seerr.dev');
    assert.equal(
      (
        await call('POST', `/user/${admin}/settings/features`, {
          disabled: ['passkeyPrompt'],
        })
      ).status,
      403,
      "not someone else's"
    );
  });

  it('stops the server doing what a turned-off feature needs', async () => {
    getSettings().main.disabledFeatures = [
      'suggestedForYou',
      'deletingSoon',
      'watchSuggestions',
      'newSeasons',
    ];

    const suggested = await call('GET', '/discover/suggested');
    assert.equal(suggested.status, 200);
    assert.deepEqual(suggested.body.results, []);

    const deleting = await call('GET', '/maintainerr/deleting');
    assert.deepEqual(deleting.body, { enabled: false, items: [] });

    assert.deepEqual((await call('GET', '/list/suggestions')).body, []);

    assert.equal((await call('POST', '/tv/1399/future-seasons')).status, 403);
  });

  it("applies someone's own switches to them, not to others", async () => {
    const friend = await userId('friend@seerr.dev');
    signedIn = 'friend@seerr.dev';
    await call('POST', `/user/${friend}/settings/features`, {
      disabled: ['newSeasons'],
    });
    assert.equal((await call('POST', '/tv/1399/future-seasons')).status, 403);

    signedIn = 'admin@seerr.dev';
    assert.equal((await call('POST', '/tv/1399/future-seasons')).status, 201);
  });
});
