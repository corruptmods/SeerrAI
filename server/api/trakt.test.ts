import TraktAPI, { parseTraktUrl, TraktError } from '@server/api/trakt';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * A stand-in api.trakt.tv per Trakt's API contract: pages of up to 250 with
 * X-Pagination headers, nested movie or series items, nullable ids.
 */
let server: http.Server;
let base = '';
let seen: { path: string; headers: http.IncomingHttpHeaders }[] = [];
let status = 200;

const item = (n: number, type = 'movie', tmdb: number | null = 1000 + n) => ({
  rank: n,
  id: n,
  listed_at: new Date(Date.UTC(2026, 0, n)).toISOString(),
  type,
  [type]: { title: `Title ${n}`, year: 2000 + n, ids: { trakt: n, tmdb } },
});

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push({ path: url.pathname + url.search, headers: req.headers });
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const page = Number(url.searchParams.get('page') ?? 1);
    let body: unknown[] = [];
    let pages: number | undefined = 1;
    let limit: number | undefined;
    if (url.pathname === '/users/someone/lists/overcounted/items/movie,show') {
      // Says five pages, but runs out after the first.
      pages = 5;
      body = page === 1 ? [item(1), item(2)] : [];
    } else if (
      url.pathname === '/users/someone/lists/uncounted/items/movie,show'
    ) {
      // No page count, only the limit applied: 3 full pages of 2, then 1.
      pages = undefined;
      limit = 2;
      body = page <= 3 ? [item(page * 2 - 1), item(page * 2)] : [item(7)];
    } else if (
      url.pathname === '/users/someone/lists/big-one/items/movie,show'
    ) {
      // 260 entries: pages of 250 and 10.
      pages = 2;
      const from = (page - 1) * 250 + 1;
      const to = Math.min(page * 250, 260);
      body = Array.from({ length: to - from + 1 }, (_, i) => item(from + i));
    } else if (url.pathname === '/users/someone/lists/mixed/items/movie,show') {
      body = [
        item(1),
        item(2, 'show'),
        item(3, 'movie', null),
        { rank: 4, type: 'season', season: { number: 1 } },
      ];
    } else if (
      url.pathname === '/users/someone/watchlist/movie,show/added/desc'
    ) {
      body = Array.from({ length: 30 }, (_, i) => item(i + 1));
    } else if (url.pathname === '/users/someone/watched/movies') {
      body = [
        {
          plays: 2,
          last_watched_at: '2026-03-02T20:00:00.000Z',
          movie: {
            title: 'Glasswing',
            year: 2011,
            ids: { trakt: 1, tmdb: 501 },
          },
        },
        {
          plays: 1,
          last_watched_at: null,
          movie: { title: 'Static Garden', year: null, ids: { trakt: 2 } },
        },
        { plays: 1, movie: null },
      ];
    } else if (url.pathname === '/users/someone/watched/shows') {
      // 300 series: pages of 250 and 50, should Trakt page them.
      pages = 2;
      const from = (page - 1) * 250 + 1;
      const to = Math.min(page * 250, 300);
      body = Array.from({ length: to - from + 1 }, (_, i) => ({
        plays: 3,
        last_watched_at: new Date(Date.UTC(2026, 0, 1)).toISOString(),
        show: {
          title: `Series ${from + i}`,
          year: 2000,
          ids: { trakt: from + i, tmdb: 9000 + from + i },
        },
      }));
    } else if (url.pathname === '/genres/movies') {
      body = [{ name: 'Action', slug: 'action' }];
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Pagination-Page': String(page),
      ...(pages !== undefined && { 'X-Pagination-Page-Count': String(pages) }),
      ...(limit !== undefined && { 'X-Pagination-Limit': String(limit) }),
    });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

beforeEach(() => {
  seen = [];
  status = 200;
});

describe('reading Trakt links', () => {
  it('reads a user’s list, their watchlist and a list by number', () => {
    assert.deepEqual(
      parseTraktUrl('https://trakt.tv/users/someone/lists/best-of-2025'),
      { kind: 'list', user: 'someone', list: 'best-of-2025' }
    );
    assert.deepEqual(
      parseTraktUrl(
        'app.trakt.tv/users/some.one/lists/123?sort_by=rank&sort_how=asc'
      ),
      { kind: 'list', user: 'some.one', list: '123' }
    );
    assert.deepEqual(
      parseTraktUrl(' https://trakt.tv/users/someone/watchlist '),
      {
        kind: 'watchlist',
        user: 'someone',
      }
    );
    assert.deepEqual(parseTraktUrl('https://trakt.tv/lists/2471'), {
      kind: 'listId',
      id: '2471',
    });
  });

  it('turns down anything else', () => {
    for (const text of [
      'The Mazewright (1999)',
      'https://example.com/users/someone/lists/x',
      'https://trakt.tv/users/someone',
      'https://trakt.tv/users/someone/watchlist/extra',
      'https://trakt.tv/lists/not-a-number',
      'https://trakt.tv/movies/the-mazewright-1999',
      // Invalid once decoded: rejected, not thrown.
      'https://trakt.tv/users/%E0%A4%A/watchlist',
      'https://trakt.tv/users/someone/lists/%ZZ',
    ]) {
      assert.equal(parseTraktUrl(text), undefined, text);
    }
  });
});

describe('the Trakt client', () => {
  it('reads every page of a list, naming itself as Trakt asks', async () => {
    const titles = await new TraktAPI('client-id', base).titles({
      kind: 'list',
      user: 'someone',
      list: 'big-one',
    });
    assert.equal(titles.length, 260);
    assert.deepEqual(
      seen.map((s) => s.path),
      [
        '/users/someone/lists/big-one/items/movie,show?page=1&limit=250',
        '/users/someone/lists/big-one/items/movie,show?page=2&limit=250',
      ]
    );
    const headers = seen[0].headers;
    assert.equal(headers['trakt-api-key'], 'client-id');
    assert.equal(headers['trakt-api-version'], '2');
    assert.match(String(headers['user-agent']), /^SeerrAI\//);
  });

  it('keeps films and series, with their ids and when they were listed', async () => {
    const titles = await new TraktAPI('client-id', base).titles({
      kind: 'list',
      user: 'someone',
      list: 'mixed',
    });
    assert.deepEqual(
      titles.map((t) => [t.type, t.title, t.year, t.tmdbId ?? null]),
      [
        ['movie', 'Title 1', 2001, 1001],
        ['show', 'Title 2', 2002, 1002],
        ['movie', 'Title 3', 2003, null],
      ],
      'a season is left out; a film Trakt has no TMDB id for stays'
    );
    assert.equal(titles[0].listedAt, Date.UTC(2026, 0, 1) / 1000);
  });

  it('gives the 20 newest titles on a watchlist, newest first', async () => {
    const titles = await new TraktAPI('client-id', base).recentWatchlist(
      'someone'
    );
    assert.equal(titles.length, 20);
    assert.equal(titles[0].title, 'Title 30');
    assert.equal(titles[19].title, 'Title 11');
  });

  it('says what went wrong in words', async () => {
    const api = new TraktAPI('client-id', base);
    const cases: [number, string][] = [
      [403, 'badKey'],
      [401, 'private'],
      [404, 'notFound'],
      [429, 'rateLimited'],
      [502, 'unreachable'],
    ];
    for (const [code, problem] of cases) {
      status = code;
      await assert.rejects(
        api.titles({ kind: 'watchlist', user: 'someone' }),
        (e: unknown) => e instanceof TraktError && e.problem === problem,
        String(code)
      );
    }
    await assert.rejects(
      new TraktAPI('client-id', 'http://127.0.0.1:1').check(),
      (e: unknown) => e instanceof TraktError && e.problem === 'unreachable'
    );
  });

  it('never asks for a path made of dots', async () => {
    // "." or ".." would change the requested address. Watchlist usernames
    // also come from user settings, not only from parsed links.
    const api = new TraktAPI('client-id', base);
    for (const name of ['.', '..', '...']) {
      await assert.rejects(
        api.recentWatchlist(name),
        (e: unknown) => e instanceof TraktError && e.problem === 'notFound',
        name
      );
      await assert.rejects(
        api.titles({ kind: 'list', user: 'someone', list: name }),
        (e: unknown) => e instanceof TraktError && e.problem === 'notFound',
        name
      );
    }
    assert.deepEqual(seen, []);
  });

  it('reads the films someone watched, with when they last did', async () => {
    const films = await new TraktAPI('client-id', base).watchedMovies(
      'someone'
    );
    assert.deepEqual(films, [
      {
        type: 'movie',
        title: 'Glasswing',
        year: 2011,
        tmdbId: 501,
        lastWatchedAt: Date.UTC(2026, 2, 2, 20) / 1000,
      },
      {
        type: 'movie',
        title: 'Static Garden',
        year: undefined,
        tmdbId: undefined,
        lastWatchedAt: undefined,
      },
    ]);
  });

  it('reads the series someone watched, every page, without each episode', async () => {
    const series = await new TraktAPI('client-id', base).watchedShows(
      'someone'
    );
    assert.equal(series.length, 300);
    assert.deepEqual(series[0], {
      type: 'show',
      title: 'Series 1',
      year: 2000,
      tmdbId: 9001,
      lastWatchedAt: Date.UTC(2026, 0, 1) / 1000,
    });
    assert.deepEqual(
      seen.map((s) => s.path),
      [
        '/users/someone/watched/shows?page=1&limit=250',
        '/users/someone/watched/shows?page=2&limit=250',
      ]
    );
  });

  it('stops at an empty page, whatever the page count says', async () => {
    const titles = await new TraktAPI('client-id', base).titles({
      kind: 'list',
      user: 'someone',
      list: 'overcounted',
    });
    assert.equal(titles.length, 2);
    assert.equal(seen.length, 2);
  });

  it('without a page count, reads on while pages are full by Trakt’s limit', async () => {
    const titles = await new TraktAPI('client-id', base).titles({
      kind: 'list',
      user: 'someone',
      list: 'uncounted',
    });
    assert.equal(titles.length, 7);
    assert.equal(seen.length, 4);
  });

  it('never asks for what a made-up name watched', async () => {
    const api = new TraktAPI('client-id', base);
    await assert.rejects(api.watchedMovies('..'), TraktError);
    await assert.rejects(api.watchedShows('a/b'), TraktError);
    assert.deepEqual(seen, []);
  });

  it('checks a Client ID with one cheap call', async () => {
    await new TraktAPI('client-id', base).check();
    assert.deepEqual(
      seen.map((s) => s.path),
      ['/genres/movies']
    );
  });
});
