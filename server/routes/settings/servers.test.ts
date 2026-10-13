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
 * Radarr, Sonarr and Maintainerr servers in settings, behind the real
 * OpenAPI validator and an error handler like the app's.
 */

setupTestDb();

let maintainerrPort = 0;
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

  // Maintainerr answering its version.
  maintainerrPort = await listen((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify('2.14.0'));
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
    ) => res.status(err.status || 500).json({ message: err.message })
  );
  port = await listen(app);
});

after(() => servers.forEach((server) => server.close()));

beforeEach(() => {
  const settings = getSettings();
  settings.radarr = [];
  settings.sonarr = [];
  settings.maintainerr = [];
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
        path: `/api/v1/settings${route}`,
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

const dvr = (name: string) => ({
  name,
  hostname: '127.0.0.1',
  port: 1,
  apiKey: 'key',
  useSsl: false,
  activeProfileId: 1,
  activeProfileName: 'Any',
  activeDirectory: '/media',
  is4k: false,
  isDefault: false,
});
const radarr = (name: string) => ({
  ...dvr(name),
  minimumAvailability: 'released',
});
const sonarr = (name: string) => ({ ...dvr(name), enableSeasonFolders: true });

describe('Radarr, Sonarr and Maintainerr servers in settings', () => {
  for (const [list, body] of [
    ['radarr', radarr],
    ['sonarr', sonarr],
  ] as const) {
    it(`never gives a new ${list} server a removed one's id`, async () => {
      await call('POST', `/${list}`, body('First'));
      const second = await call('POST', `/${list}`, body('Second'));
      const id = Number(second.body.id);

      // Removing the newest server, and then every server.
      assert.equal((await call('DELETE', `/${list}/${id}`)).status, 200);
      const third = await call('POST', `/${list}`, body('Third'));
      assert.deepEqual([third.status, third.body.id], [201, id + 1]);
      getSettings()[list] = [];
      const fourth = await call('POST', `/${list}`, body('Fourth'));
      assert.equal(fourth.body.id, id + 2);
    });
  }

  it("never gives a new Maintainerr server a removed one's id", async () => {
    const server = (name: string) => ({
      name,
      hostname: '127.0.0.1',
      port: maintainerrPort,
      useSsl: false,
      urlBase: '',
    });
    await call('POST', '/maintainerr', server('First'));
    const second = await call('POST', '/maintainerr', server('Second'));
    assert.equal(second.status, 201);
    const id = Number(second.body.id);
    await call('DELETE', `/maintainerr/${id}`);
    const third = await call('POST', '/maintainerr', server('Third'));
    assert.deepEqual([third.status, third.body.id], [201, id + 1]);
  });

  it('answers 404 for a Radarr server that is not set up', async () => {
    for (const [method, route, body] of [
      ['PUT', '/radarr/7', radarr('Gone')],
      ['GET', '/radarr/7/profiles', undefined],
      ['DELETE', '/radarr/7', undefined],
    ] as const) {
      const { status, body: answer } = await call(method, route, body);
      assert.deepEqual(
        [status, answer.message],
        [404, 'Settings instance not found'],
        `${method} ${route}`
      );
    }
  });
});
