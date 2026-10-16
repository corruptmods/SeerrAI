import { getSettings } from '@server/lib/settings';
import settingsRoutes from '@server/routes/settings';
import restartFlag from '@server/utils/restartFlag';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import request from 'supertest';

/*
 * Settings → Network: the proxies trusted with Enable Proxy Support on,
 * besides those on this machine, the local network and Tailscale.
 */

const app = express();
app.use(express.json());
app.use(
  OpenApiValidator.middleware({
    apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
    validateRequests: true,
    validateSecurity: false,
  })
);
app.use('/api/v1/settings', settingsRoutes);
app.use(
  (
    err: { status?: number; message: string },
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction
  ) => {
    res.status(err.status ?? 500).json({ message: err.message });
  }
);

beforeEach(() => {
  const network = getSettings().network;
  network.trustProxy = true;
  network.trustCloudflare = false;
  network.trustedProxies = [];
  restartFlag.initializeSettings(getSettings());
});

describe('the trusted proxy settings', () => {
  it('start with Cloudflare not trusted and nothing listed', async () => {
    const res = await request(app).get('/api/v1/settings/network');
    assert.equal(res.status, 200);
    assert.equal(res.body.trustCloudflare, false);
    assert.deepEqual(res.body.trustedProxies, []);
  });

  it('save Trust Cloudflare and the listed proxies as entered', async () => {
    const res = await request(app)
      .post('/api/v1/settings/network')
      .send({
        trustProxy: true,
        trustCloudflare: true,
        trustedProxies: ['198.51.100.20', ' 2001:db8::/32 ', '', '10.1.0.0/16'],
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.trustCloudflare, true);
    assert.deepEqual(res.body.trustedProxies, [
      '198.51.100.20',
      '2001:db8::/32',
      '10.1.0.0/16',
    ]);
    assert.equal(getSettings().network.trustCloudflare, true);
    assert.deepEqual(getSettings().network.trustedProxies, [
      '198.51.100.20',
      '2001:db8::/32',
      '10.1.0.0/16',
    ]);
  });

  it('replace the whole list, so a shorter one leaves nothing behind', async () => {
    getSettings().network.trustedProxies = ['198.51.100.20', '198.51.100.21'];
    const res = await request(app)
      .post('/api/v1/settings/network')
      .send({ trustedProxies: ['203.0.113.0/24'] });
    assert.equal(res.status, 200);
    assert.deepEqual(getSettings().network.trustedProxies, ['203.0.113.0/24']);

    const emptied = await request(app)
      .post('/api/v1/settings/network')
      .send({ trustedProxies: [] });
    assert.equal(emptied.status, 200);
    assert.deepEqual(getSettings().network.trustedProxies, []);
  });

  it('keep the list when a save leaves it out', async () => {
    getSettings().network.trustedProxies = ['198.51.100.20'];
    const res = await request(app)
      .post('/api/v1/settings/network')
      .send({ csrfProtection: false });
    assert.equal(res.status, 200);
    assert.deepEqual(getSettings().network.trustedProxies, ['198.51.100.20']);
  });

  it('refuse an entry that is not an address or range, naming it', async () => {
    getSettings().network.trustedProxies = ['198.51.100.20'];
    for (const bad of ['proxy.example.com', '198.51.100.0/33', 'loopback']) {
      const res = await request(app)
        .post('/api/v1/settings/network')
        .send({
          trustCloudflare: true,
          trustedProxies: ['203.0.113.5', bad],
        });
      assert.equal(res.status, 400, bad);
      assert.equal(res.body.invalidProxy, bad);
      assert.match(res.body.message, new RegExp(bad.replace(/\./g, '\\.')));
    }
    // Nothing from a refused save is kept.
    assert.equal(getSettings().network.trustCloudflare, false);
    assert.deepEqual(getSettings().network.trustedProxies, ['198.51.100.20']);
  });

  it('refuse a list that is not a list of text', async () => {
    const res = await request(app)
      .post('/api/v1/settings/network')
      .send({ trustedProxies: '198.51.100.20' });
    assert.equal(res.status, 400);
    assert.deepEqual(getSettings().network.trustedProxies, []);
  });

  it('need a restart to take effect, like Enable Proxy Support', async () => {
    assert.equal(restartFlag.isSet(), false);
    await request(app)
      .post('/api/v1/settings/network')
      .send({ trustCloudflare: true });
    assert.equal(restartFlag.isSet(), true);

    await request(app)
      .post('/api/v1/settings/network')
      .send({ trustCloudflare: false });
    assert.equal(restartFlag.isSet(), false);

    await request(app)
      .post('/api/v1/settings/network')
      .send({ trustedProxies: ['198.51.100.20'] });
    assert.equal(restartFlag.isSet(), true);
  });
});
