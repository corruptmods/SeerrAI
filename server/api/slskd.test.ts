import SlskdAPI from '@server/api/slskd';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Searching Soulseek through a stand-in slskd. slskd's timeout counts from
 * the last answer, so a popular search can run on; one cleared while it
 * runs fails in slskd, so it is stopped, and finished, first.
 */

const ANSWER = {
  username: 'collector',
  files: [
    { filename: 'Music\\Glasswing\\Static Garden\\03 - Lantern Song.flac' },
  ],
  hasFreeUploadSlot: true,
  queueLength: 0,
  uploadSpeed: 1_000_000,
};

let server: Server;
let slskd: SlskdAPI;
/** Each request, as "METHOD /path". */
let seen: string[];
/** Whether the search finishes on its own after a look or two. */
let finishes: boolean;
let state: string;
let looks: number;

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '').replace(/^\/api\/v0/, '');
    seen.push(`${req.method} ${path.replace(/[0-9a-f-]{36}/, ':id')}`);
    const json = (status: number, body?: unknown) =>
      res
        .writeHead(status, { 'Content-Type': 'application/json' })
        .end(body === undefined ? undefined : JSON.stringify(body));
    if (req.method === 'POST' && path === '/searches') {
      return json(200, { id: 'x', state: 'InProgress', responseCount: 0 });
    }
    if (req.method === 'GET' && /^\/searches\/[^/]+$/.test(path)) {
      looks++;
      if (finishes && looks >= 2) state = 'Completed, TimedOut';
      return json(200, { id: 'x', state, responseCount: 1 });
    }
    if (req.method === 'PUT' && /^\/searches\/[^/]+$/.test(path)) {
      // Stopping finishes it: slskd saves it as cancelled.
      state = 'Completed, Cancelled';
      return json(200);
    }
    if (req.method === 'GET' && path.endsWith('/responses')) {
      return json(200, [ANSWER]);
    }
    if (req.method === 'DELETE') return json(204);
    return json(404);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  slskd = new SlskdAPI({ url: `http://127.0.0.1:${port}/`, apiKey: 'key' });
});

after(() => {
  server.close();
});

beforeEach(() => {
  seen = [];
  state = 'InProgress';
  looks = 0;
});

describe('a Soulseek search', () => {
  const quick = { searchMs: 20, pollMs: 10 };

  it('answers with what was found once slskd finishes it, then is cleared', async () => {
    finishes = true;
    assert.deepEqual(await slskd.search('glasswing lantern song', quick), [
      ANSWER,
    ]);
    assert.ok(!seen.includes('PUT /searches/:id'), 'never stopped');
    assert.equal(seen.at(-1), 'DELETE /searches/:id');
  });

  it('is stopped and finished before it is cleared when it runs on', async () => {
    finishes = false;
    assert.deepEqual(await slskd.search('glasswing lantern song', quick), [
      ANSWER,
    ]);
    const stop = seen.indexOf('PUT /searches/:id');
    assert.ok(stop > 0, 'stopped');
    // Looked at once more, finished, before its answers are read.
    assert.equal(seen[stop + 1], 'GET /searches/:id');
    assert.deepEqual(seen.slice(-2), [
      'GET /searches/:id/responses',
      'DELETE /searches/:id',
    ]);
  });
});
