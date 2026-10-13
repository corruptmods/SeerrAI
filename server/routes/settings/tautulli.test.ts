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
 * Tautulli in settings, against a stand-in that checks its API key and
 * reports a version as the real one does, behind the real OpenAPI validator.
 */

setupTestDb();

let tautulliPort = 0;
let version = 'v2.15.3';
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

  tautulliPort = await listen((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (url.searchParams.get('apikey') !== 'the-key') {
      res.statusCode = 401;
      return res.end(
        JSON.stringify({ response: { result: 'error', data: {} } })
      );
    }
    res.end(
      JSON.stringify({
        response: { result: 'success', data: { tautulli_version: version } },
      })
    );
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
  version = 'v2.15.3';
  getSettings().tautulli = {
    hostname: '',
    port: 8181,
    useSsl: false,
    urlBase: '',
    apiKey: '',
    externalUrl: '',
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
        path: `/api/v1/settings/tautulli${route}`,
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

const tautulli = (apiKey: string) => ({
  hostname: '127.0.0.1',
  port: tautulliPort,
  useSsl: false,
  urlBase: '',
  apiKey,
  externalUrl: '',
});

describe('Tautulli in settings', () => {
  it('saves Tautulli only once the key works', async () => {
    const wrong = await call('POST', '', tautulli('not-it'));
    assert.deepEqual(
      [wrong.status, wrong.body.message],
      [400, 'Could not reach Tautulli, or it did not accept the API key.']
    );
    assert.equal(getSettings().tautulli.hostname, '');

    const saved = await call('POST', '', tautulli('the-key'));
    assert.equal(saved.status, 200);
    assert.equal(getSettings().tautulli.apiKey, 'the-key');
  });

  it('refuses a Tautulli older than 2.9', async () => {
    version = 'v2.8.1';
    const old = await call('POST', '/test', tautulli('the-key'));
    assert.deepEqual(
      [old.status, old.body.message],
      [400, 'Tautulli v2.8.1 is too old; 2.9 or later is needed.']
    );
  });

  it('never sends the key back, and keeps it when left blank', async () => {
    await call('POST', '', tautulli('the-key'));
    const { body } = await call('GET', '');
    assert.deepEqual([body.apiKey, body.hasApiKey], ['', true]);

    const tested = await call('POST', '/test', tautulli(''));
    assert.deepEqual([tested.status, tested.body.version], [200, 'v2.15.3']);
    await call('POST', '', {
      ...tautulli(''),
      externalUrl: 'https://tautulli.example.com/',
    });
    assert.deepEqual(
      [getSettings().tautulli.externalUrl, getSettings().tautulli.apiKey],
      ['https://tautulli.example.com', 'the-key']
    );
  });

  it('does not send the saved key to a different address', async () => {
    await call('POST', '', tautulli('the-key'));
    const moved = [
      { ...tautulli(''), hostname: 'localhost' },
      { ...tautulli(''), useSsl: true },
      { ...tautulli(''), urlBase: '/tautulli' },
    ];
    for (const body of moved) {
      const tested = await call('POST', '/test', body);
      assert.deepEqual(
        [tested.status, tested.body.message],
        [400, 'Enter Tautulli’s API key.'],
        JSON.stringify(body)
      );
    }
    const saved = await call('POST', '', moved[0]);
    assert.equal(saved.status, 400);
    assert.equal(getSettings().tautulli.hostname, '127.0.0.1');
  });

  it('takes over Tautulli as the Plex page saved it', async () => {
    // As the old form stored it: no useSsl at all, no hasApiKey.
    getSettings().tautulli = {
      hostname: '127.0.0.1',
      port: tautulliPort,
      urlBase: '',
      apiKey: 'the-key',
      externalUrl: 'https://tautulli.example.com',
    };
    delete getSettings().tautulli.useSsl;

    const { body } = await call('GET', '');
    assert.deepEqual(
      [body.hostname, body.apiKey, body.hasApiKey, body.useSsl],
      ['127.0.0.1', '', true, undefined]
    );

    // Saved again from the new dialog, which sends a blank key.
    const saved = await call('POST', '', {
      hostname: '127.0.0.1',
      port: tautulliPort,
      useSsl: false,
      urlBase: '',
      apiKey: '',
      externalUrl: 'https://tautulli.example.com',
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(getSettings().tautulli, {
      hostname: '127.0.0.1',
      port: tautulliPort,
      useSsl: false,
      urlBase: '',
      apiKey: 'the-key',
      externalUrl: 'https://tautulli.example.com',
    });
  });

  it('keeps the URL base joinable onto the address', async () => {
    const { status } = await call('POST', '/test', {
      ...tautulli('the-key'),
      urlBase: 'tautulli/',
    });
    // The stand-in answers on any path; what matters is what is saved.
    assert.equal(status, 200);
    await call('POST', '', { ...tautulli('the-key'), urlBase: 'tautulli/' });
    assert.equal(getSettings().tautulli.urlBase, '/tautulli');
  });

  it('disconnects Tautulli', async () => {
    await call('POST', '', tautulli('the-key'));
    assert.equal((await call('DELETE', '')).status, 200);
    assert.deepEqual(
      [getSettings().tautulli.hostname, getSettings().tautulli.apiKey],
      ['', '']
    );
  });
});
