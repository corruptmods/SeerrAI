import routes from '@server/routes';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

/*
 * /list was the only route group mounted without a sign-in check; each list
 * route checked for itself. Through the real top-level router, with nobody
 * signed in, every list path is refused at the group — including one that
 * matches no list route at all, which a route-level check could not cover.
 */

setupTestDb();

let server: Server;
let port: number;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', routes);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  port = (server.address() as { port: number }).port;
});
after(() => server?.close());

const status = (path: string) =>
  new Promise<number>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on('error', reject);
  });

describe('the list routes with nobody signed in', () => {
  it('refuses them at the group', async () => {
    for (const path of [
      '/api/v1/list',
      '/api/v1/list/1',
      '/api/v1/list/markers',
      '/api/v1/list/a/b/c/d',
    ]) {
      assert.equal(await status(path), 403, path);
    }
  });
});
