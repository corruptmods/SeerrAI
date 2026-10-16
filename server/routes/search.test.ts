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
 * they are searched for separately and shown with the rest. Search can also
 * be for films only (with their collections) or series only.
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
const series = (id: number) => ({
  id,
  media_type: 'tv',
  name: `Series ${id}`,
  original_name: `Series ${id}`,
  overview: '',
  poster_path: null,
  backdrop_path: null,
  genre_ids: [],
  original_language: 'en',
  popularity: 1,
  vote_average: 7,
  vote_count: 10,
  first_air_date: '2020-01-01',
  origin_country: ['US'],
});
// TMDB's film and series searches leave out media_type: every result is
// of the one kind asked for.
const untyped = (result: object) =>
  Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== 'media_type')
  );
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
let filmPages: Record<number, ReturnType<typeof film>[]> = {};
let seriesPages: Record<number, ReturnType<typeof series>[]> = {};
/** Which of TMDB's searches were used. */
let asked: string[] = [];

const stub = (name: string, value: unknown) =>
  Object.defineProperty(TheMovieDb.prototype, name, {
    configurable: true,
    set() {},
    get() {
      return value;
    },
  });
stub('searchMulti', async ({ page = 1 }: { page?: number }) => {
  asked.push('multi');
  return {
    page,
    total_pages: multiTotal.pages,
    total_results: multiTotal.results,
    results: multiPages[page] ?? [],
  };
});
stub('searchMovies', async ({ page = 1 }: { page?: number }) => {
  asked.push('movie');
  return {
    page,
    total_pages: Object.keys(filmPages).length || 1,
    total_results: Object.values(filmPages).flat().length,
    results: (filmPages[page] ?? []).map(untyped),
  };
});
stub('searchTvShows', async ({ page = 1 }: { page?: number }) => {
  asked.push('tv');
  return {
    page,
    total_pages: Object.keys(seriesPages).length || 1,
    total_results: Object.values(seriesPages).flat().length,
    results: (seriesPages[page] ?? []).map(untyped),
  };
});
stub('getByExternalId', async () => ({
  movie_results: [untyped(film(1))],
  tv_results: [untyped(series(2))],
  person_results: [],
}));
stub('searchCollection', async ({ page = 1 }: { page?: number }) => {
  asked.push('collection');
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
  filmPages = {};
  seriesPages = {};
  asked = [];
});

const search = async (page = 1, more = '') => {
  const res = await fetch(
    `http://127.0.0.1:${port}/api/v1/search?query=alien&page=${page}${more}`
  );
  const text = await res.text();
  return {
    status: res.status,
    body: (res.ok ? JSON.parse(text) : { error: text }) as {
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

describe('GET /search for one kind of title', () => {
  beforeEach(() => {
    multiPages = { 1: [film(1), series(2) as never] };
    multiTotal = { pages: 1, results: 2 };
    filmPages = { 1: [film(1), film(3)], 2: [film(5)] };
    seriesPages = { 1: [series(2), series(4)] };
    collectionPages = { 1: [collection(8091)] };
    collectionTotal = { pages: 1, results: 1 };
  });

  it('finds films, with their collections ahead of them', async () => {
    const { status, body } = await search(1, '&type=movie');

    assert.equal(status, 200);
    assert.deepEqual(shown(body.results), [
      'collection:8091',
      'movie:1',
      'movie:3',
    ]);
    assert.deepEqual(asked.sort(), ['collection', 'movie']);
    assert.equal(body.results[1].title, 'Film 1');
    assert.equal(body.totalPages, 2);
    assert.equal(body.totalResults, 4);

    const second = await search(2, '&type=movie');
    assert.deepEqual(shown(second.body.results), ['movie:5']);
  });

  it('finds series only', async () => {
    const { status, body } = await search(1, '&type=tv');

    assert.equal(status, 200);
    assert.deepEqual(shown(body.results), ['tv:2', 'tv:4']);
    assert.deepEqual(asked, ['tv']);
    assert.equal(body.totalResults, 2);
  });

  it('searches everything without a type, or with type=all', async () => {
    for (const more of ['', '&type=all']) {
      asked = [];
      const { status, body } = await search(1, more);
      assert.equal(status, 200, JSON.stringify(body));
      assert.deepEqual(shown(body.results), [
        'collection:8091',
        'movie:1',
        'tv:2',
      ]);
      assert.deepEqual(asked.sort(), ['collection', 'multi']);
    }
  });

  it('keeps to the kind asked for when looking up an id', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/v1/search?query=imdb%3Att0078748&type=tv`
    );
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as {
      totalResults: number;
      results: { id: number; mediaType: string }[];
    };

    assert.deepEqual(shown(body.results), ['tv:2']);
    assert.equal(body.totalResults, 1);
  });

  it('refuses a kind it does not know', async () => {
    const { status } = await search(1, '&type=music');
    assert.equal(status, 400);
  });
});
