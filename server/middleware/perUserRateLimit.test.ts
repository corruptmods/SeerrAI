import type { User } from '@server/entity/User';
import { perUserRateLimit } from '@server/middleware/perUserRateLimit';
import express from 'express';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it, mock } from 'node:test';

/*
 * Behind a reverse proxy ("trust proxy" on), the limit counts people, not
 * the forwarded addresses anyone can set, and says nothing to the log.
 */

const serve = async () => {
  const app = express();
  app.enable('trust proxy');
  app.use((req, _res, next) => {
    req.user = { id: Number(req.header('x-user')) } as User;
    next();
  });
  app.get('/', perUserRateLimit({ windowMs: 60_000, limit: 2 }), (_req, res) =>
    res.json({ ok: true })
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const get = async (user: number, forwardedFor: string) =>
    (
      await fetch(`http://127.0.0.1:${port}/`, {
        headers: { 'x-user': String(user), 'x-forwarded-for': forwardedFor },
      })
    ).status;
  return { server, get };
};

describe('perUserRateLimit', () => {
  it('counts each person, whatever address they claim', async () => {
    const errors = mock.method(console, 'error', () => undefined);
    const { server, get } = await serve();
    try {
      assert.equal(await get(1, '10.0.0.1'), 200);
      assert.equal(await get(1, '10.0.0.2'), 200);
      // A new forwarded address does not buy another try.
      assert.equal(await get(1, '10.0.0.3'), 429);
      // Someone else has their own count.
      assert.equal(await get(2, '10.0.0.1'), 200);
      assert.equal(errors.mock.callCount(), 0);
    } finally {
      errors.mock.restore();
      server.close();
    }
  });
});
