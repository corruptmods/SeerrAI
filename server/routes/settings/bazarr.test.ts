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
 * Bazarr in settings, against a stand-in that checks its API key as the
 * real one does, behind the real OpenAPI validator.
 */

setupTestDb();

let bazarrPort = 0;
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

  bazarrPort = await listen((req, res) => {
    if (req.headers['x-api-key'] !== 'the-key') {
      res.statusCode = 401;
      return res.end('Unauthorized');
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { bazarr_version: '1.6.3-beta.5' } }));
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
  port = await listen(app);
});

after(() => servers.forEach((server) => server.close()));

beforeEach(() => {
  getSettings().bazarr = {
    hostname: '',
    port: 6767,
    useSsl: false,
    urlBase: '',
    apiKey: '',
  };
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
        path: `/api/v1/settings/bazarr${route}`,
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

const bazarr = (apiKey: string) => ({
  hostname: '127.0.0.1',
  port: bazarrPort,
  useSsl: false,
  urlBase: '',
  apiKey,
});

describe('Bazarr in settings', () => {
  it('saves Bazarr only once the key works', async () => {
    const wrong = await call('PUT', '', bazarr('not-it'));
    assert.deepEqual(
      [wrong.status, wrong.body.message],
      [400, 'Bazarr did not accept the API key.']
    );
    assert.equal(getSettings().bazarr.apiKey, '');

    const saved = await call('PUT', '', bazarr('the-key'));
    assert.equal(saved.status, 200);
    assert.equal(getSettings().bazarr.apiKey, 'the-key');
    assert.equal(getSettings().fullPublicSettings.subtitlesReady, true);
  });

  it('never sends the key back, and keeps it when left blank', async () => {
    await call('PUT', '', bazarr('the-key'));
    const { body } = await call('GET', '');
    assert.deepEqual([body.apiKey, body.hasApiKey], ['', true]);

    assert.equal((await call('POST', '/test', bazarr(''))).status, 200);
    await call('PUT', '', { ...bazarr(''), urlBase: '/bazarr' });
    assert.deepEqual(
      [getSettings().bazarr.urlBase, getSettings().bazarr.apiKey],
      ['/bazarr', 'the-key']
    );
  });

  it('disconnects Bazarr', async () => {
    await call('PUT', '', bazarr('the-key'));
    assert.equal((await call('DELETE', '')).status, 200);
    assert.equal(getSettings().fullPublicSettings.subtitlesReady, false);
  });
});
