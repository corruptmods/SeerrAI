import { getSettings } from '@server/lib/settings';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Download clients in settings, against a stand-in SABnzbd that checks its
 * key as the real one does, behind the real OpenAPI validator.
 */

setupTestDb();

let sabPort = 0;
let nzbgetPort = 0;
let port = 0;
const servers: Server[] = [];

before(async () => {
  const listen = (app: http.RequestListener) =>
    new Promise<number>((resolve) => {
      const server = http.createServer(app).listen(0, () => {
        resolve((server.address() as AddressInfo).port);
      });
      servers.push(server);
    });

  sabPort = await listen((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (url.searchParams.get('mode') === 'version') {
      return res.end(JSON.stringify({ version: '5.1.3' }));
    }
    if (url.searchParams.get('apikey') !== 'the-key') {
      return res.end(
        JSON.stringify({ status: false, error: 'API Key Incorrect' })
      );
    }
    res.end(JSON.stringify({ queue: { slots: [] } }));
  });

  // NZBGet behind basic auth, answering its version.
  nzbgetPort = await listen((req, res) => {
    const auth = Buffer.from(
      String(req.headers.authorization ?? '').replace(/^Basic /, ''),
      'base64'
    ).toString();
    if (auth !== 'nzbget:pw') {
      res.statusCode = 401;
      return res.end();
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: '24.3', id: 1 }));
  });

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
      // Express tells an error handler by its four parameters.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
  port = await listen(app);
});

after(() => servers.forEach((server) => server.close()));

beforeEach(() => {
  getSettings().downloadClients = [];
});

const call = <T = Record<string, unknown>>(
  method: string,
  route: string,
  body?: unknown
) =>
  new Promise<{ status: number; body: T }>((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v1/settings/download-clients${route}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : undefined,
          })
        );
      }
    );
    req.on('error', reject);
    req.end(payload);
  });

const sab = (apiKey: string) => ({
  name: 'SABnzbd',
  type: 'sabnzbd',
  hostname: '127.0.0.1',
  port: sabPort,
  useSsl: false,
  urlBase: '',
  apiKey,
});

describe('download clients in settings', () => {
  it('adds a client only once the key works', async () => {
    const wrong = await call('POST', '', sab('not-it'));
    assert.equal(wrong.status, 400);
    assert.match(String(wrong.body.message), /API Key Incorrect/);
    assert.equal(getSettings().downloadClients.length, 0);

    const added = await call('POST', '', sab('the-key'));
    assert.equal(added.status, 201);
    assert.equal(getSettings().downloadClients[0].apiKey, 'the-key');
  });

  it('never sends the key back, only that one is saved', async () => {
    await call('POST', '', sab('the-key'));
    const { body } = await call<Record<string, unknown>[]>('GET', '');
    assert.equal(body[0].apiKey, '');
    assert.equal(body[0].hasApiKey, true);
    assert.equal(JSON.stringify(body).includes('the-key'), false);
  });

  it('keeps the saved key when it is left blank', async () => {
    const added = await call('POST', '', sab('the-key'));
    const id = Number(added.body.id);

    const tested = await call('POST', '/test', { ...sab(''), id });
    assert.equal(tested.status, 200, 'testing uses the saved key');

    const renamed = await call('PUT', `/${id}`, {
      ...sab(''),
      name: 'Usenet',
    });
    assert.equal(renamed.status, 200);
    const [saved] = getSettings().downloadClients;
    assert.deepEqual([saved.name, saved.apiKey], ['Usenet', 'the-key']);
  });

  it('removes a client', async () => {
    const added = await call('POST', '', sab('the-key'));
    const removed = await call('DELETE', `/${added.body.id}`);
    assert.equal(removed.status, 200);
    assert.equal(getSettings().downloadClients.length, 0);
    assert.equal((await call('DELETE', `/${added.body.id}`)).status, 404);
  });

  it('adds NZBGet with its sign-in, and keeps the password left blank', async () => {
    const nzbget = (password: string) => ({
      name: 'NZBGet',
      type: 'nzbget',
      hostname: '127.0.0.1',
      port: nzbgetPort,
      useSsl: false,
      urlBase: '',
      username: 'nzbget',
      password,
    });
    const wrong = await call('POST', '', nzbget('nope'));
    assert.deepEqual(
      [wrong.status, wrong.body.message],
      [400, 'NZBGet did not accept the username or password.']
    );

    const added = await call('POST', '', nzbget('pw'));
    assert.equal(added.status, 201);
    assert.deepEqual([added.body.password, added.body.hasPassword], ['', true]);

    const kept = await call('PUT', `/${added.body.id}`, nzbget(''));
    assert.equal(kept.status, 200);
    assert.equal(getSettings().downloadClients[0].password, 'pw');
  });

  it('refuses an address with a scheme or path in the host', async () => {
    const { status } = await call('POST', '/test', {
      ...sab('the-key'),
      hostname: 'http://nas:8080',
    });
    assert.equal(status, 400);
  });
});
