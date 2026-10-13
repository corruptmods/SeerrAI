import { aiChatBody, jsonBody } from '@server/middleware/jsonBody';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

/*
 * A photo for AI Search may be up to 8 MB; every other body, and AI
 * Search's from someone not signed in, keeps the usual small limit.
 */

setupTestDb();

const serve = async () => {
  const app = express();
  app.use(jsonBody);
  // Stands in for the session: x-user is the signed-in person's id.
  app.use((req, _res, next) => {
    if (req.header('x-user')) {
      (req as unknown as { session: { userId: number } }).session = {
        userId: Number(req.header('x-user')),
      };
    }
    next();
  });
  app.use(aiChatBody);
  app.post('/{*rest}', (req, res) => {
    res.json({ length: JSON.stringify(req.body ?? {}).length });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const post = async (path: string, body: unknown, user?: number) =>
    (
      await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(user ? { 'x-user': String(user) } : {}),
        },
        body: JSON.stringify(body),
      })
    ).status;
  return { server, post };
};

// About a megabyte: over the usual limit, well under the photo limit.
const photo = { image: { type: 'image/jpeg', data: 'a'.repeat(1_000_000) } };

describe('JSON request bodies', () => {
  it('takes a large photo for AI Search only from someone signed in', async () => {
    const { server, post } = await serve();
    try {
      assert.equal(await post('/api/v1/ai/chat', photo, 1), 200);
      assert.equal(await post('/api/v1/ai/chat/', photo, 1), 200);
      // Not signed in: the usual limit, before the route turns them away.
      assert.equal(await post('/api/v1/ai/chat', photo), 413);
      // Signed in as nobody the server knows.
      assert.equal(await post('/api/v1/ai/chat', photo, 999), 413);
      // A small message still reaches the route either way.
      assert.equal(await post('/api/v1/ai/chat', { message: 'hi' }), 200);
    } finally {
      server.close();
    }
  });

  it('keeps the usual limit everywhere else, signed in or not', async () => {
    const { server, post } = await serve();
    try {
      assert.equal(await post('/api/v1/request', photo, 1), 413);
      assert.equal(await post('/api/v1/ai/chatter', photo, 1), 413);
      assert.equal(await post('/api/v1/request', { mediaId: 1 }), 200);
    } finally {
      server.close();
    }
  });
});
