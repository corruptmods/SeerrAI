import { getRepository } from '@server/datasource';
import { Session } from '@server/entity/Session';
import { sessionStoreFor } from '@server/lib/sessionStore';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it, mock } from 'node:test';

setupTestDb();

/*
 * Postgres briefly out of connections fails one session write. Seerr must
 * keep signing people in afterwards: the store used to mark itself gone
 * for good, leaving every later request without a session.
 */

let server: Server | undefined;

after(() => {
  server?.closeAllConnections();
  server?.close();
});

describe('the session store', () => {
  it('keeps working after one failed write', async () => {
    const repository = getRepository(Session);
    const app = express();
    app.use(
      session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
        store: sessionStoreFor(repository),
      })
    );
    app.post('/sign-in', (req, res) => {
      if (!req.session) {
        res.status(503).json({ problem: 'no session' });
        return;
      }
      (req.session as unknown as { signedIn: boolean }).signedIn = true;
      req.session.save((error) =>
        error ? res.status(500).json({ problem: 'save failed' }) : res.json({})
      );
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sign-in`;

    const insert = repository.insert.bind(repository);
    let failed = false;
    mock.method(repository, 'insert', async (...args: unknown[]) => {
      if (!failed) {
        failed = true;
        throw new Error('sorry, too many clients already');
      }
      return insert(...(args as Parameters<typeof insert>));
    });

    assert.equal((await fetch(url, { method: 'POST' })).status, 500);
    const again = await fetch(url, { method: 'POST' });
    assert.equal(again.status, 200, JSON.stringify(await again.json()));
    assert.match(again.headers.get('set-cookie') ?? '', /connect\.sid=/);
    mock.restoreAll();
  });
});
