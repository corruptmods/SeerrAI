import TraktAPI, { parseTraktUrl, TraktError } from '@server/api/trakt';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * A stand-in for api.trakt.tv answering as Trakt's API contract describes:
 * pages of at most 250 with X-Pagination headers, items with the film or
 * series nested, ids that may be null.
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
    let pages = 1;
    if (url.pathname === '/users/someone/lists/big-one/items/movie,show') {
      // 260 entries: a page of 250 and one of 10.
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
    } else if (url.pathname === '/genres/movies') {
      body = [{ name: 'Action', slug: 'action' }];
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Pagination-Page': String(page),
      'X-Pagination-Page-Count': String(pages),
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
    // A user or list called "." or ".." would change which address is asked
    // for, rather than name anyone: a watchlist username comes from a
    // person's own settings, not only from a parsed link.
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

  it('checks a Client ID with one cheap call', async () => {
    await new TraktAPI('client-id', base).check();
    assert.deepEqual(
      seen.map((s) => s.path),
      ['/genres/movies']
    );
  });
});
