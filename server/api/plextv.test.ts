import PlexTvAPI, { WATCHLIST_SHUFFLE_MAX } from '@server/api/plextv';
import cacheManager from '@server/lib/cache';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/*
 * A user's Plex watchlist and its cache: a reply from Discover that is not
 * a watchlist must never be kept, or If-None-Match pins it and every later
 * request gets a 304 for it.
 */

interface Reply {
  status: number;
  etag?: string;
  data?: unknown;
}

const watchlist = (...ratingKeys: string[]) => ({
  MediaContainer: {
    totalSize: ratingKeys.length,
    Metadata: ratingKeys.map((ratingKey) => ({ ratingKey })),
  },
});

const metadata = (ratingKey: string, tmdbId: number) => ({
  MediaContainer: {
    Metadata: [
      {
        ratingKey,
        type: 'movie',
        title: `Movie ${tmdbId}`,
        Guid: [{ id: `tmdb://${tmdbId}` }],
      },
    ],
  },
});

/**
 * A PlexTvAPI whose watchlist requests get the given replies in turn, and
 * whose metadata lookups answer from a table. Records the If-None-Match sent.
 */
const apiWith = (replies: Reply[], details: Record<string, unknown> = {}) => {
  const api = new PlexTvAPI('token-a');
  const sent: (string | undefined)[] = [];
  const internals = api as unknown as {
    axios: { get: (...args: unknown[]) => Promise<unknown> };
    getRolling: (url: string) => Promise<unknown>;
  };
  internals.axios.get = async (_url, config) => {
    const headers = (config as { headers?: Record<string, string> }).headers;
    sent.push(headers?.['If-None-Match']);
    const reply = replies.shift();
    if (!reply) {
      throw new Error('no more replies');
    }
    return {
      status: reply.status,
      headers: reply.etag ? { etag: reply.etag } : {},
      data: reply.data,
    };
  };
  internals.getRolling = async (url) => {
    const key = url.split('/').pop() as string;
    if (!(key in details)) {
      throw Object.assign(new Error('not found'), {
        response: { status: 404 },
      });
    }
    return details[key];
  };
  return { api, sent };
};

beforeEach(() => {
  cacheManager.getCache('plexwatchlist').flush();
});

describe('PlexTvAPI.getWatchlist', () => {
  it('shuffles the whole watchlist by a seed, looking up only a page of it', async () => {
    const keys = Array.from({ length: 30 }, (_, i) => `k${i}`);
    const details = Object.fromEntries(
      keys.map((key, i) => [key, metadata(key, 1000 + i)])
    );
    const { api } = apiWith(
      [
        { status: 200, etag: '"v1"', data: watchlist(...keys) },
        { status: 304 },
        { status: 304 },
      ],
      details
    );
    const internals = api as unknown as {
      axios: { get: (...args: unknown[]) => Promise<unknown> };
      getRolling: (url: string) => Promise<unknown>;
    };
    const asked: unknown[] = [];
    const listing = internals.axios.get;
    internals.axios.get = async (url, config) => {
      asked.push((config as { params: unknown }).params);
      return listing(url, config);
    };
    let lookups = 0;
    const lookup = internals.getRolling;
    internals.getRolling = async (url) => {
      lookups++;
      return lookup(url);
    };

    const first = await api.getWatchlist({ offset: 0, shuffle: 7 });
    const second = await api.getWatchlist({ offset: 20, shuffle: 7 });

    // The whole of it asked for each time, and only each page looked up.
    assert.deepEqual(asked[0], {
      'X-Plex-Container-Start': 0,
      'X-Plex-Container-Size': WATCHLIST_SHUFFLE_MAX,
    });
    assert.equal(lookups, 30);
    assert.deepEqual(
      [first.items.length, second.items.length, first.totalSize],
      [20, 10, 30]
    );
    const shown = [...first.items, ...second.items].map((i) => i.tmdbId);
    assert.equal(new Set(shown).size, 30, 'every title once over the pages');
    assert.notDeepEqual(
      shown,
      keys.map((_, i) => 1000 + i),
      'not in the watchlist’s own order'
    );

    // The same seed, the same order.
    const again = await api.getWatchlist({ offset: 0, shuffle: 7 });
    assert.deepEqual(
      again.items.map((i) => i.tmdbId),
      first.items.map((i) => i.tmdbId)
    );
  });

  it('keeps a watchlist with its ETag and asks with it next time', async () => {
    const { api, sent } = apiWith(
      [{ status: 200, etag: '"v1"', data: watchlist('a') }, { status: 304 }],
      { a: metadata('a', 603) }
    );
    const first = await api.getWatchlist();
    const second = await api.getWatchlist();
    assert.deepEqual(sent, [undefined, '"v1"']);
    assert.deepEqual(
      [first.items.map((i) => i.tmdbId), second.items.map((i) => i.tmdbId)],
      [[603], [603]]
    );
    assert.equal(second.totalSize, 1);
  });

  it('never keeps a reply that is not a watchlist, so it cannot be pinned', async () => {
    const { api, sent } = apiWith(
      [
        { status: 200, etag: '"bad"', data: { error: 'upstream blip' } },
        { status: 200, etag: '"v2"', data: watchlist('a') },
      ],
      { a: metadata('a', 603) }
    );
    const broken = await api.getWatchlist();
    assert.deepEqual(
      [broken.items, broken.totalSize, broken.authFailed],
      [[], 0, undefined]
    );
    const recovered = await api.getWatchlist();
    // The bad reply's ETag was never sent back, so Plex answered in full.
    assert.deepEqual(sent, [undefined, undefined]);
    assert.deepEqual(
      recovered.items.map((i) => i.tmdbId),
      [603]
    );
  });

  it('uses the last good watchlist when a reply is not one', async () => {
    const { api, sent } = apiWith(
      [
        { status: 200, etag: '"v1"', data: watchlist('a', 'b') },
        { status: 200, etag: '"bad"', data: { MediaContainer: [] } },
        { status: 304 },
      ],
      { a: metadata('a', 603), b: metadata('b', 604) }
    );
    await api.getWatchlist();
    const during = await api.getWatchlist();
    await api.getWatchlist();
    assert.deepEqual(
      during.items.map((i) => i.tmdbId),
      [603, 604]
    );
    assert.equal(during.totalSize, 2);
    // Still asking with the good ETag after the bad reply.
    assert.deepEqual(sent, [undefined, '"v1"', '"v1"']);
  });

  it('skips an item whose metadata reply has no MediaContainer', async () => {
    const { api } = apiWith(
      [{ status: 200, etag: '"v1"', data: watchlist('a', 'b') }],
      { a: {}, b: metadata('b', 604) }
    );
    const result = await api.getWatchlist();
    assert.deepEqual(
      result.items.map((i) => i.tmdbId),
      [604]
    );
  });

  it('reads the items when Plex lists them under Video', async () => {
    const { api } = apiWith(
      [
        {
          status: 200,
          etag: '"v1"',
          data: {
            MediaContainer: { totalSize: 1, Video: [{ ratingKey: 'a' }] },
          },
        },
      ],
      { a: metadata('a', 603) }
    );
    const result = await api.getWatchlist();
    assert.deepEqual(
      result.items.map((i) => i.tmdbId),
      [603]
    );
  });

  it('asks without If-None-Match when Plex sent no ETag', async () => {
    const { api, sent } = apiWith(
      [
        { status: 200, data: watchlist() },
        { status: 200, data: watchlist() },
      ],
      {}
    );
    await api.getWatchlist();
    await api.getWatchlist();
    assert.deepEqual(sent, [undefined, undefined]);
  });
});
