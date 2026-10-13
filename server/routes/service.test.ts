import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import serviceRoutes from '@server/routes/service';
import express from 'express';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
 * The Radarr and Sonarr details the request window reads, which anyone
 * signed in can ask for, when the server does not answer.
 */

let app: Server;
let port = 0;
/** A port nothing listens on. */
let closedPort = 0;
let warned: string[] = [];

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port)
    )
  );

before(async () => {
  const closed = createServer();
  closedPort = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));

  const routes = express();
  routes.use('/service', serviceRoutes);
  // As the real server does: the error's message goes to the person.
  routes.use(
    (
      err: { status?: number; message: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
  app = createServer(routes);
  port = await listen(app);
});

after(() => app.close());

beforeEach(() => {
  const server = {
    id: 0,
    name: 'Main',
    hostname: '127.0.0.1',
    port: closedPort,
    apiKey: 'the-api-key',
    useSsl: false,
    baseUrl: '',
    is4k: false,
    isDefault: true,
  };
  getSettings().radarr = [server as RadarrSettings];
  getSettings().sonarr = [server as SonarrSettings];
  warned = [];
  mock.method(logger, 'warn', (...args: unknown[]) => {
    warned.push(JSON.stringify(args));
    return logger;
  });
});

afterEach(() => mock.restoreAll());

describe('a Radarr or Sonarr that does not answer', () => {
  for (const kind of ['radarr', 'sonarr']) {
    it(`says so plainly for ${kind}, and logs where it tried`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/service/${kind}/0`);
      const body = (await res.json()) as { message: string };
      assert.equal(res.status, 500);
      assert.doesNotMatch(body.message, /127\.0\.0\.1|ECONNREFUSED/);
      assert.match(body.message, /did not answer/);
      assert.equal(warned.length, 1);
      assert.match(warned[0], /ECONNREFUSED/);
      assert.doesNotMatch(warned[0], /the-api-key/);
    });
  }
});
