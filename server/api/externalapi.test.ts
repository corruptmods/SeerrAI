import ExternalAPI from '@server/api/externalapi';
import PlexAPI from '@server/api/plexapi';
import TheMovieDb from '@server/api/themoviedb';
import Tvdb from '@server/api/tvdb';
import type { CacheStats, CacheStore } from '@server/lib/cache';
import logger from '@server/logger';
import type { AxiosInstance } from 'axios';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';

/*
 * The shared client every outside service is reached through: its cache,
 * its background refresh, and how long it waits.
 */

/** A cache whose entries can be made to look old. */
class TestCache implements CacheStore {
  public entries = new Map<string, { value: unknown; expires: number }>();
  get<T>(key: string): T | undefined {
    return this.entries.get(key)?.value as T | undefined;
  }
  set<T>(key: string, value: T, ttl = 300): boolean {
    this.entries.set(key, { value, expires: Date.now() + ttl * 1000 });
    return true;
  }
  del(key: string): number {
    return this.entries.delete(key) ? 1 : 0;
  }
  getTtl(key: string): number | undefined {
    return this.entries.get(key)?.expires;
  }
  getStats(): CacheStats {
    return { hits: 0, misses: 0, keys: this.entries.size, ksize: 0, vsize: 0 };
  }
  flushAll(): void {
    this.entries.clear();
  }
  /** Every entry as if it had been kept this long ago. */
  age(ms: number) {
    for (const entry of this.entries.values()) {
      entry.expires -= ms;
    }
  }
}

class Probe extends ExternalAPI {
  constructor(baseUrl: string, cache: CacheStore) {
    super(baseUrl, { apikey: 'the-secret-key' }, { nodeCache: cache });
  }
  public rolling() {
    return this.getRolling<{ n: number }>('/profiles', undefined, 60);
  }
  public login(ttl?: number) {
    return this.post<{ n: number }>('/login', { user: 'u' }, undefined, ttl);
  }
}

let server: Server;
let base = '';
let failing = false;
/** Holds answers to /profiles open until released. */
let gate: Promise<void> | undefined;
const asked: string[] = [];

before(async () => {
  server = createServer(async (req, res) => {
    asked.push(`${req.method} ${req.url?.split('?')[0]}`);
    if (req.url?.startsWith('/profiles') && gate) {
      await gate;
    }
    res.setHeader('Content-Type', 'application/json');
    if (failing) {
      res.statusCode = 503;
      return res.end('{}');
    }
    res.end(JSON.stringify({ n: asked.length }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

beforeEach(() => {
  asked.length = 0;
  failing = false;
  gate = undefined;
});

afterEach(() => mock.restoreAll());

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('a background refresh', () => {
  it('logs a failure in a line, without the request, and goes unhandled nowhere', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const warned: unknown[][] = [];
    mock.method(logger, 'warn', (...args: unknown[]) => {
      warned.push(args);
      return logger;
    });
    try {
      const cache = new TestCache();
      const api = new Probe(base, cache);
      assert.deepEqual(await api.rolling(), { n: 1 });
      cache.age(30_000);
      failing = true;
      assert.deepEqual(await api.rolling(), { n: 1 }, 'the kept answer');
      await settle();
      assert.deepEqual(unhandled, []);
      assert.equal(warned.length, 1);
      const logged = JSON.stringify(warned[0]);
      assert.match(logged, /503/);
      assert.doesNotMatch(logged, /the-secret-key/);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('refreshes each answer once at a time', async () => {
    const cache = new TestCache();
    const api = new Probe(base, cache);
    await api.rolling();
    cache.age(30_000);
    let release: () => void = () => undefined;
    gate = new Promise<void>((resolve) => (release = resolve));
    await Promise.all([api.rolling(), api.rolling(), api.rolling()]);
    // Another client for the same server shares the refresh.
    await new Probe(base, cache).rolling();
    release();
    await settle();
    assert.deepEqual(asked, ['GET /profiles', 'GET /profiles']);
    assert.deepEqual(await api.rolling(), { n: 2 }, 'the refreshed answer');
  });
});

describe('a POST', () => {
  it('is sent every time unless its caller asks for it to be kept', async () => {
    const api = new Probe(base, new TestCache());
    await api.login();
    await api.login();
    assert.equal(asked.length, 2, 'a sign-in is not kept');
    await api.login(60);
    await api.login(60);
    assert.equal(asked.length, 3, 'kept when asked');
  });
});

describe('how long a client waits', () => {
  const timeoutOf = (api: unknown) =>
    (api as { axios: AxiosInstance }).axios.defaults.timeout;

  it('gives up on TMDB, TheTVDB and Plex after a while', () => {
    for (const [name, api] of [
      ['TMDB', new TheMovieDb()],
      ['TheTVDB', new Tvdb()],
      ['Plex', new PlexAPI({ plexToken: 'x' })],
    ] as const) {
      const timeout = timeoutOf(api);
      assert.ok(timeout && timeout > 0, `${name} waits forever`);
    }
  });

  it('keeps a timeout Plex is given', () => {
    assert.equal(
      timeoutOf(new PlexAPI({ plexToken: 'x', timeout: 5000 })),
      5000
    );
  });
});
