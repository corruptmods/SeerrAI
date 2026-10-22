import TheMovieDb from '@server/api/themoviedb';
import type { User } from '@server/entity/User';
import discoverRoutes from '@server/routes/discover';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * What each poster on a page can be filtered by, from stubbed TMDB details,
 * behind the real API validator.
 */

setupTestDb();

let asked: string[] = [];
const stub = (name: string, value: unknown) =>
  Object.defineProperty(TheMovieDb.prototype, name, {
    configurable: true,
    set() {},
    get() {
      return value;
    },
  });
stub('getMovie', async ({ movieId }: { movieId: number }) => {
  asked.push(`movie:${movieId}`);
  if (movieId === 404) {
    throw new Error('not found');
  }
  // TMDB taking longer than the server waits before answering.
  if (movieId === 777) {
    await new Promise((resolve) => setTimeout(resolve, 6500));
  }
  return {
    id: movieId,
    title: `Film ${movieId}`,
    original_title: 'Le Film',
    credits: {
      cast: [
        { name: 'Garrick Holt', character: 'Tam Vexley' },
        { name: 'Garrick Holt', character: 'Dakota Reyes' },
      ],
      crew: [
        { name: 'Morris Thane', job: 'Director' },
        { name: 'Lyle Brannock', job: 'Producer' },
      ],
    },
    genres: [{ id: 1, name: 'Science Fiction' }],
    keywords: { keywords: [{ id: 1, name: 'space opera' }] },
    production_companies: [{ id: 1, name: 'Thanefilm Ltd.' }],
  };
});
stub('getTvShow', async ({ tvId }: { tvId: number }) => {
  asked.push(`tv:${tvId}`);
  return {
    id: tvId,
    name: `Show ${tvId}`,
    original_name: `Show ${tvId}`,
    aggregate_credits: {
      cast: [
        { name: 'Brock Tallard', roles: [{ character: 'Nils Halvorsen' }] },
      ],
    },
    credits: { crew: [] },
    created_by: [{ name: 'Dean Ferrow' }],
    genres: [{ id: 2, name: 'Crime' }],
    keywords: { results: [] },
    production_companies: [{ id: 2, name: 'Amazon MGM Studios' }],
    networks: [{ id: 3, name: 'Prime Video' }],
  };
});

let app: Server;
let port: number;

before(async () => {
  const ex = express();
  ex.use(express.json());
  ex.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  ex.use((req, _res, next) => {
    (req as unknown as { user: Partial<User> }).user = { id: 1 };
    next();
  });
  ex.use('/api/v1/discover', discoverRoutes);
  app = await new Promise<Server>((resolve) => {
    const s = ex.listen(0, () => resolve(s));
  });
  port = (app.address() as { port: number }).port;
});
after(() => app?.close());
beforeEach(() => {
  asked = [];
});

const get = async (ids: string) => {
  const started = Date.now();
  const res = await fetch(
    `http://127.0.0.1:${port}/api/v1/discover/search-text?ids=${encodeURIComponent(ids)}`
  );
  const body = (await res.json()) as {
    text: Record<string, string>;
    pending?: string[];
  };
  return {
    status: res.status,
    text: body.text,
    pending: body.pending ?? [],
    tookMs: Date.now() - started,
  };
};

describe('GET /discover/search-text', () => {
  it('gives names, cast and characters, makers, genres and keywords', async () => {
    const { status, text } = await get('movie:11');

    assert.equal(status, 200);
    const words = ` ${text['movie:11']} `;
    for (const word of [
      'film',
      'le',
      'garrick',
      'holt',
      'tam',
      'vexley',
      'dakota',
      'thane',
      'science',
      'space',
      'opera',
      'thanefilm',
    ]) {
      assert.ok(words.includes(` ${word} `), `has "${word}"`);
    }
    assert.ok(!words.includes(' brannock '), 'not a producer');
    assert.equal(
      words.split(' garrick ').length,
      2,
      'each word once, however many roles'
    );
  });

  it('covers series: cast by role, and who created it', async () => {
    const { text } = await get('tv:22');

    assert.match(text['tv:22'], /\bnils halvorsen\b/);
    assert.match(text['tv:22'], /\bferrow\b/);
    assert.match(text['tv:22'], /\bcrime\b/);
    assert.match(text['tv:22'], /\bamazon mgm studios\b/);
    assert.match(text['tv:22'], /\bprime video\b/);
  });

  it('leaves out a title TMDB cannot answer for, and anything malformed', async () => {
    const { status, text } = await get('movie:404,movie:12,person:5,movie:x');

    assert.equal(status, 200);
    assert.deepEqual(Object.keys(text), ['movie:12']);
  });

  it('asks TMDB once per title, however often it is asked', async () => {
    await get('movie:30,tv:31');
    await get('movie:30,tv:31');

    assert.deepEqual(asked.sort(), ['movie:30', 'tv:31']);
  });

  it('refuses an address with unescaped ":" and ",", so the page escapes them', async () => {
    // Seerr's API validator rejects reserved characters in a query. The page
    // once let axios send them as they were, and every request failed.
    const res = await fetch(
      `http://127.0.0.1:${port}/api/v1/discover/search-text?ids=movie:11,tv:22`
    );

    assert.equal(res.status, 400);
  });

  it('answers at most 60 titles a call', async () => {
    const ids = Array.from({ length: 70 }, (_, i) => `movie:${1000 + i}`);

    const { text } = await get(ids.join(','));

    assert.equal(Object.keys(text).length, 60);
  });
});

describe('GET /discover/search-text, when TMDB is slow', () => {
  it('answers with what is ready and says what is still coming', async () => {
    const first = await get('movie:776,movie:777');

    assert.ok(first.tookMs < 6000, `answered in ${first.tookMs} ms`);
    assert.deepEqual(Object.keys(first.text), ['movie:776']);
    assert.deepEqual(first.pending, ['movie:777']);

    // The lookup carried on in the background: asked again, it is there.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const second = await get('movie:777');

    assert.ok(second.text['movie:777']);
    assert.deepEqual(second.pending, []);
    assert.equal(
      asked.filter((key) => key === 'movie:777').length,
      1,
      'looked up once, not once per ask'
    );
  });
});
