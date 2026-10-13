import TheMovieDb from '@server/api/themoviedb';
// Loads every entity in order before the route's own imports reach them.
import '@server/datasource';
import searchRoutes from '@server/routes/search';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Search: TMDB's search across everything never returns collections, so
 * they are searched for separately and shown with the rest.
 */

setupTestDb();

const film = (id: number) => ({
  id,
  media_type: 'movie',
  title: `Film ${id}`,
  original_title: `Film ${id}`,
  overview: '',
  poster_path: null,
  backdrop_path: null,
  genre_ids: [],
  original_language: 'en',
  popularity: 1,
  vote_average: 7,
  vote_count: 10,
  adult: false,
  release_date: '2020-01-01',
  video: false,
});
const collection = (id: number) => ({
  id,
  name: `Collection ${id}`,
  original_name: `Collection ${id}`,
  overview: 'Every film in it',
  poster_path: `/c${id}.jpg`,
  backdrop_path: null,
  original_language: 'en',
  adult: false,
});

// Pages of each search, by page number; TMDB pages hold up to 20.
let multiPages: Record<number, ReturnType<typeof film>[]> = {};
let multiTotal = { pages: 1, results: 0 };
let collectionPages: Record<number, ReturnType<typeof collection>[]> = {};
let collectionTotal = { pages: 1, results: 0 };
let collectionsDown = false;
let collectionPagesAsked: number[] = [];

const stub = (name: string, value: unknown) =>
  Object.defineProperty(TheMovieDb.prototype, name, {
    configurable: true,
    set() {},
    get() {
      return value;
    },
  });
stub('searchMulti', async ({ page = 1 }: { page?: number }) => ({
  page,
  total_pages: multiTotal.pages,
  total_results: multiTotal.results,
  results: multiPages[page] ?? [],
}));
stub('searchCollection', async ({ page = 1 }: { page?: number }) => {
  collectionPagesAsked.push(page);
  if (collectionsDown) {
    throw new Error('[TMDB] Failed to search collections: timeout');
  }
  return {
    page,
    total_pages: collectionTotal.pages,
    total_results: collectionTotal.results,
    results: collectionPages[page] ?? [],
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
  ex.use('/api/v1/search', searchRoutes);
  app = await new Promise<Server>((resolve) => {
    const s = ex.listen(0, () => resolve(s));
  });
  port = (app.address() as { port: number }).port;
});
after(() => {
  app?.close();
});

beforeEach(() => {
  multiPages = {};
  multiTotal = { pages: 1, results: 0 };
  collectionPages = {};
  collectionTotal = { pages: 1, results: 0 };
  collectionsDown = false;
  collectionPagesAsked = [];
});

const search = async (page = 1) => {
  const res = await fetch(
    `http://127.0.0.1:${port}/api/v1/search?query=alien&page=${page}`
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      page: number;
      totalPages: number;
      totalResults: number;
      results: { id: number; mediaType: string; title?: string }[];
    },
  };
};
const shown = (results: { id: number; mediaType: string }[]) =>
  results.map((r) => `${r.mediaType}:${r.id}`);

describe('GET /search', () => {
  it('shows matching collections, as collections, ahead of the rest', async () => {
    multiPages = { 1: [film(1), film(2)] };
    multiTotal = { pages: 1, results: 2 };
    collectionPages = { 1: [collection(8091)] };
    collectionTotal = { pages: 1, results: 1 };

    const { status, body } = await search();

    assert.equal(status, 200);
    assert.deepEqual(shown(body.results), [
      'collection:8091',
      'movie:1',
      'movie:2',
    ]);
    const found = body.results[0] as Record<string, unknown>;
    assert.equal(found.title, 'Collection 8091');
    assert.equal(found.posterPath, '/c8091.jpg');
    assert.equal(found.overview, 'Every film in it');
    assert.equal(body.totalResults, 3);
    assert.equal(body.totalPages, 1);
  });

  it('pages through both, for as long as either has more', async () => {
    multiPages = { 1: [film(1)], 2: [film(2)], 3: [film(3)] };
    multiTotal = { pages: 3, results: 3 };
    collectionPages = { 1: [collection(10)], 2: [collection(20)] };
    collectionTotal = { pages: 2, results: 2 };

    const pages = [await search(1), await search(2), await search(3)];

    assert.deepEqual(
      pages.map((p) => shown(p.body.results)),
      [['collection:10', 'movie:1'], ['collection:20', 'movie:2'], ['movie:3']]
    );
    assert.deepEqual(
      pages.map((p) => [p.body.totalPages, p.body.totalResults]),
      [
        [3, 5],
        [3, 5],
        [3, 5],
      ]
    );
    // Past the collections' last page there is nothing more to ask for.
    assert.ok(!collectionPagesAsked.includes(3));
  });

  it('keeps going while only collections are left', async () => {
    multiPages = { 1: [film(1)] };
    multiTotal = { pages: 1, results: 1 };
    collectionPages = { 1: [collection(10)], 2: [collection(20)] };
    collectionTotal = { pages: 2, results: 2 };

    const second = await search(2);

    assert.equal(second.body.totalPages, 2);
    assert.deepEqual(shown(second.body.results), ['collection:20']);
  });

  it('still finds films and series when the collection search fails', async () => {
    multiPages = { 1: [film(1)] };
    multiTotal = { pages: 1, results: 1 };
    collectionsDown = true;

    const { status, body } = await search();

    assert.equal(status, 200);
    assert.deepEqual(shown(body.results), ['movie:1']);
    assert.equal(body.totalResults, 1);
  });
});
