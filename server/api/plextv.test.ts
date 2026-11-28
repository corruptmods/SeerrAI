import PlexTvAPI from '@server/api/plextv';
import cacheManager from '@server/lib/cache';
import { AxiosError, type AxiosResponse } from 'axios';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/*
 * Watchlist caching: a Discover reply that isn't a watchlist must never be
 * cached, or If-None-Match pins it and every later request gets a 304.
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
 * A PlexTvAPI whose watchlist requests get `replies` in turn and whose
 * metadata lookups answer from `details`. Records each If-None-Match sent.
 */
const apiWith = (replies: Reply[], details: Record<string, unknown> = {}) => {
  const api = new PlexTvAPI('token-a');
  const sent: (string | undefined)[] = [];
  /** Each request's sort param. */
  const sorts: unknown[] = [];
  const internals = api as unknown as {
    axios: { get: (...args: unknown[]) => Promise<unknown> };
    getRolling: (url: string) => Promise<unknown>;
  };
  internals.axios.get = async (_url, config) => {
    const headers = (config as { headers?: Record<string, string> }).headers;
    sent.push(headers?.['If-None-Match']);
    sorts.push((config as { params?: { sort?: unknown } }).params?.sort);
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
  return { api, sent, sorts };
};

beforeEach(() => {
  cacheManager.getCache('plexwatchlist').flush();
});

describe('PlexTvAPI.getWatchlist', () => {
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

  it('keeps each page of a watchlist apart, with its own ETag', async () => {
    const { api, sent } = apiWith(
      [
        { status: 200, etag: '"p1"', data: watchlist('a') },
        { status: 200, etag: '"p2"', data: watchlist('b') },
        { status: 304 },
      ],
      { a: metadata('a', 603), b: metadata('b', 604) }
    );
    await api.getWatchlist({ offset: 0 });
    await api.getWatchlist({ offset: 20 });
    const again = await api.getWatchlist({ offset: 20 });
    // Page 2 is requested without page 1's ETag, and its 304 serves its own
    // titles.
    assert.deepEqual(sent, [undefined, undefined, '"p2"']);
    assert.deepEqual(
      again.items.map((i) => i.tmdbId),
      [604]
    );
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
    // The good ETag is still sent after the bad reply.
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

  it('asks Plex for an order only when one is chosen', async () => {
    const { api, sorts } = apiWith(
      [
        { status: 200, data: watchlist('a') },
        { status: 200, data: watchlist('a') },
        { status: 200, data: watchlist('a') },
        { status: 200, data: watchlist('a') },
      ],
      { a: metadata('a', 603) }
    );
    await api.getWatchlist();
    await api.getWatchlist({ sort: 'added-desc' });
    await api.getWatchlist({ sort: 'added-asc' });
    await api.getWatchlist({ sort: 'title' });
    assert.deepEqual(sorts, [
      undefined,
      'watchlistedAt:desc',
      'watchlistedAt:asc',
      'titleSort:asc',
    ]);
  });

  it('keeps each order apart, with its own ETag', async () => {
    const { api, sent } = apiWith(
      [
        { status: 200, etag: '"own"', data: watchlist('a', 'b') },
        { status: 200, etag: '"newest"', data: watchlist('b', 'a') },
        { status: 304 },
      ],
      { a: metadata('a', 603), b: metadata('b', 604) }
    );
    await api.getWatchlist();
    await api.getWatchlist({ sort: 'added-desc' });
    const again = await api.getWatchlist({ sort: 'added-desc' });
    assert.deepEqual(sent, [undefined, undefined, '"newest"']);
    assert.deepEqual(
      again.items.map((i) => i.tmdbId),
      [604, 603]
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

/*
 * Account and servers: plex.tv's v2 JSON routes, read into exactly what the
 * older account.json and XML resources gave, which stay as the fallback.
 */
describe('PlexTvAPI account and servers', () => {
  const gone = (status: number) =>
    new AxiosError(
      `Request failed with status code ${status}`,
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      { status } as AxiosResponse
    );

  /** A PlexTvAPI answering `routes` by path, recording each path asked. */
  const plexTv = (routes: Record<string, unknown>) => {
    const api = new PlexTvAPI('token-a');
    const asked: string[] = [];
    const sent: Record<string, unknown>[] = [];
    (
      api as unknown as {
        axios: { get: (...args: unknown[]) => Promise<unknown> };
      }
    ).axios.get = async (url, config) => {
      asked.push(url as string);
      sent.push((config ?? {}) as Record<string, unknown>);
      const answer = routes[url as string];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw gone(404);
      return { status: 200, data: answer };
    };
    return { api, asked, sent };
  };

  const accountJson = {
    user: {
      id: 4021,
      uuid: 'c0ffee00c0ffee00',
      email: 'glasswing@example.invalid',
      joined_at: '2019-06-24 11:38:02 UTC',
      username: 'glasswing',
      title: 'Glasswing',
      thumb: 'https://plex.tv/users/c0ffee00c0ffee00/avatar?c=1',
      hasPassword: true,
      authToken: 'token-a',
      subscription: {
        active: true,
        status: 'Active',
        plan: 'lifetime',
        features: ['webhooks'],
      },
      roles: { roles: ['plexpass'] },
      entitlements: ['all'],
    },
  };
  const userV2 = {
    id: 4021,
    uuid: 'c0ffee00c0ffee00',
    email: 'glasswing@example.invalid',
    joinedAt: Date.UTC(2019, 5, 24, 11, 38, 2) / 1000,
    username: 'glasswing',
    title: 'Glasswing',
    thumb: 'https://plex.tv/users/c0ffee00c0ffee00/avatar?c=1',
    hasPassword: true,
    authToken: 'token-a',
    subscription: {
      active: true,
      status: 'Active',
      plan: 'lifetime',
      features: ['webhooks'],
    },
    roles: ['plexpass'],
    entitlements: ['all'],
    friendlyName: 'Glasswing',
  };

  const created = Date.UTC(2024, 0, 2, 3, 4, 5) / 1000;
  const seen = Date.UTC(2026, 10, 27, 8, 9, 10) / 1000;
  const resourcesXml = `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer size="1">
  <Device name="Harbour Lights" product="Plex Media Server" productVersion="1.42.1" platform="Linux" platformVersion="6.1" device="PC" clientIdentifier="machine-1" createdAt="${created}" lastSeenAt="${seen}" provides="server" owned="1" accessToken="server-token" publicAddress="203.0.113.7" httpsRequired="0" synced="0" relay="1" dnsRebindingProtection="0" natLoopbackSupported="1" publicAddressMatches="1" presence="1" ownerID="77" home="0" sourceTitle="lantern">
    <Connection protocol="https" address="192.168.1.20" port="32400" uri="https://192-168-1-20.abc.plex.direct:32400" local="1"/>
    <Connection protocol="https" address="203.0.113.7" port="32400" uri="https://203-0-113-7.abc.plex.direct:32400" local="0"/>
  </Device>
</MediaContainer>`;
  const resourcesV2 = [
    {
      name: 'Harbour Lights',
      product: 'Plex Media Server',
      productVersion: '1.42.1',
      platform: 'Linux',
      platformVersion: '6.1',
      device: 'PC',
      clientIdentifier: 'machine-1',
      createdAt: new Date(created * 1000).toISOString().replace('.000', ''),
      lastSeenAt: new Date(seen * 1000).toISOString().replace('.000', ''),
      provides: 'server',
      owned: true,
      accessToken: 'server-token',
      publicAddress: '203.0.113.7',
      httpsRequired: false,
      synced: false,
      relay: true,
      dnsRebindingProtection: false,
      natLoopbackSupported: true,
      publicAddressMatches: true,
      presence: true,
      ownerId: 77,
      home: false,
      sourceTitle: 'lantern',
      connections: [
        {
          protocol: 'https',
          address: '192.168.1.20',
          port: 32400,
          uri: 'https://192-168-1-20.abc.plex.direct:32400',
          local: true,
          relay: false,
          IPv6: false,
        },
        {
          protocol: 'https',
          address: '203.0.113.7',
          port: 32400,
          uri: 'https://203-0-113-7.abc.plex.direct:32400',
          local: false,
          relay: false,
          IPv6: false,
        },
      ],
    },
  ];

  it('reads the account from /api/v2/user as account.json gave it', async () => {
    const fromV2 = plexTv({ '/api/v2/user': userV2 });
    const fromOld = plexTv({ '/users/account.json': accountJson });
    assert.deepEqual(await fromV2.api.getUser(), await fromOld.api.getUser());
    assert.deepEqual(fromV2.asked, ['/api/v2/user']);
    assert.ok(
      (fromV2.sent[0].headers as Record<string, string>)[
        'X-Plex-Client-Identifier'
      ]
    );
  });

  it('reads servers from /api/v2/resources as the XML route gave them', async () => {
    const fromV2 = plexTv({ '/api/v2/resources': resourcesV2 });
    const fromOld = plexTv({
      '/api/v2/resources': gone(410),
      '/api/resources?includeHttps=1': resourcesXml,
    });
    const v2 = await fromV2.api.getDevices();
    assert.deepEqual(v2, await fromOld.api.getDevices());
    assert.equal(v2[0].connection.length, 2);
    assert.equal(v2[0].createdAt.getTime(), created * 1000);
    assert.deepEqual(fromV2.sent[0].params, { includeHttps: 1 });
    assert.deepEqual(fromOld.asked, [
      '/api/v2/resources',
      '/api/resources?includeHttps=1',
    ]);
  });

  it('reads the older routes when a v2 route fails or answers unexpectedly', async () => {
    for (const reply of [gone(500), { id: 'odd' }, null]) {
      const plex = plexTv({
        '/api/v2/user': reply,
        '/users/account.json': accountJson,
      });
      assert.equal((await plex.api.getUser()).username, 'glasswing');
      assert.deepEqual(plex.asked, ['/api/v2/user', '/users/account.json']);
    }
    for (const reply of [
      gone(502),
      { not: 'a list' },
      [{ name: 'Harbour Lights' }],
    ]) {
      const plex = plexTv({
        '/api/v2/resources': reply,
        '/api/resources?includeHttps=1': resourcesXml,
      });
      assert.ok((await plex.api.getDevices()).length > 0);
      assert.deepEqual(plex.asked, [
        '/api/v2/resources',
        '/api/resources?includeHttps=1',
      ]);
    }
  });

  it('falls back to account.json when the v2 route is missing, but not for a refused token', async () => {
    const fallback = plexTv({
      '/api/v2/user': gone(410),
      '/users/account.json': accountJson,
    });
    assert.equal((await fallback.api.getUser()).username, 'glasswing');
    assert.deepEqual(fallback.asked, ['/api/v2/user', '/users/account.json']);

    const refused = plexTv({
      '/api/v2/user': gone(401),
      '/users/account.json': accountJson,
    });
    await assert.rejects(refused.api.getUser(), /Invalid auth token/);
    assert.deepEqual(refused.asked, ['/api/v2/user']);
  });
});
