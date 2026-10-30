import ProwlarrAPI from '@server/api/prowlarr';
import { BACKFILL_DEFAULTS, getSettings } from '@server/lib/settings';
import backfillSettingsRoutes from '@server/routes/settings/backfill';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
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

/*
 * Prowlarr's connection, set up in Settings → Services apart from the rest
 * of Backfill's settings, and kept by Backfill's own form, which leaves it
 * out.
 */

setupTestDb();

let server: Server;
let port = 0;
let answers = true;

const call = (method: 'get' | 'put', url: string, data?: unknown) =>
  axios.request({
    method,
    url: `http://127.0.0.1:${port}/api/v1/settings/backfill${url}`,
    data,
    validateStatus: () => true,
  });

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.use('/api/v1/settings/backfill', backfillSettingsRoutes);
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
});

after(() => server?.close());

beforeEach(() => {
  answers = true;
  getSettings().backfill = { ...BACKFILL_DEFAULTS, enabled: false };
  mock.method(ProwlarrAPI.prototype, 'getVersion', async () => {
    if (!answers) throw new Error('connect ECONNREFUSED');
    return '1.30.0';
  });
});

afterEach(() => mock.restoreAll());

/** Backfill's own form, which leaves Prowlarr out. */
const withoutProwlarr = () =>
  Object.fromEntries(
    Object.entries(getSettings().backfill).filter(([key]) => key !== 'prowlarr')
  );

const PROWLARR = {
  hostname: 'prowlarr',
  port: 9696,
  useSsl: false,
  urlBase: '',
};

describe('Prowlarr, in Services', () => {
  it('is saved once it answers, and its key is never sent back', async () => {
    answers = false;
    const refused = await call('put', '/prowlarr', {
      ...PROWLARR,
      apiKey: 'k1',
    });
    assert.equal(refused.status, 400);
    assert.equal(getSettings().backfill.prowlarr.apiKey, '');

    answers = true;
    const saved = await call('put', '/prowlarr', { ...PROWLARR, apiKey: 'k1' });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.apiKey, '');
    assert.equal(saved.data.hasApiKey, true);
    assert.equal(getSettings().backfill.prowlarr.apiKey, 'k1');

    const shown = await call('get', '/prowlarr');
    assert.deepEqual(shown.data, { ...PROWLARR, apiKey: '', hasApiKey: true });
  });

  it('keeps the saved key when left blank, only at the same address', async () => {
    await call('put', '/prowlarr', { ...PROWLARR, apiKey: 'k1' });
    await call('put', '/prowlarr', { ...PROWLARR, port: 9697, apiKey: '' });
    assert.equal(getSettings().backfill.prowlarr.port, 9696, 'not saved');
    assert.equal(
      (await call('put', '/prowlarr', { ...PROWLARR, apiKey: '' })).status,
      200
    );
    assert.equal(getSettings().backfill.prowlarr.apiKey, 'k1');
  });

  it('is removed with a blank address, but not while Backfill is on', async () => {
    await call('put', '/prowlarr', { ...PROWLARR, apiKey: 'k1' });
    getSettings().backfill = { ...getSettings().backfill, enabled: true };
    const kept = await call('put', '/prowlarr', { ...PROWLARR, hostname: '' });
    assert.equal(kept.status, 400);
    assert.match(kept.data.message, /Turn Backfill off first/);

    getSettings().backfill = { ...getSettings().backfill, enabled: false };
    const gone = await call('put', '/prowlarr', { ...PROWLARR, hostname: '' });
    assert.equal(gone.status, 200);
    assert.equal(getSettings().backfill.prowlarr.hostname, '');
    assert.equal(getSettings().backfill.prowlarr.apiKey, '');
  });

  it('stays as it is when Backfill’s own form is saved without it', async () => {
    await call('put', '/prowlarr', { ...PROWLARR, apiKey: 'k1' });
    const form = withoutProwlarr();
    const saved = await call('put', '', {
      ...form,
      enabled: true,
      blockedGroups: undefined,
      downloadCheck: undefined,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(getSettings().backfill.enabled, true);
    assert.equal(getSettings().backfill.prowlarr.apiKey, 'k1');
  });

  it('is asked for when Backfill is turned on without it', async () => {
    const form = withoutProwlarr();
    const refused = await call('put', '', {
      ...form,
      enabled: true,
      blockedGroups: undefined,
      downloadCheck: undefined,
    });
    assert.equal(refused.status, 400);
    assert.match(refused.data.message, /Set it up in Settings → Services/);
  });
});
