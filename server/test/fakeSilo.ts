import type {
  SiloCatalogItem,
  SiloServerStatus,
  SiloUserLibrary,
} from '@server/api/silo/types';
import type { SiloSettings } from '@server/lib/settings';
import { siloDefaults } from '@server/lib/settings';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * A local Silo for tests: the /api/v2 routes Seerr AI calls, answered from
 * test-provided data. Like Silo it checks API key scopes (403), refuses
 * admin routes to a non-admin key, pages with cursors bound to the query's
 * filters, refuses a limit over 200 and parameters a route doesn't take, and
 * records every call.
 */

export interface FakeSiloCall {
  method: string;
  path: string;
  query: Record<string, string>;
  auth?: string;
  body?: Record<string, unknown>;
}

export interface FakeSiloKey {
  /** Empty: an unscoped key, allowed everything its owner is. */
  scopes: string[];
  admin: boolean;
}

export interface FakeSiloAccount {
  id: string;
  username: string;
  password: string;
  role: 'admin' | 'user';
}

export interface FakeSilo {
  calls: FakeSiloCall[];
  apiMajor: number;
  serverVersion: string;
  contractDigest: string;
  serverId: string;
  serverName: string;
  keys: Map<string, FakeSiloKey>;
  accounts: FakeSiloAccount[];
  libraries: SiloUserLibrary[];
  items: SiloCatalogItem[];
  status: SiloServerStatus;
  /** Silo refuses to create keys (a household PIN rule, say). */
  refuseKeyCreation: boolean;
  /** Answers every call with a 429 this many times first. */
  rateLimited: number;
  /** While set, every call gets a server error. */
  down: boolean;
  /** The settings for a connected Silo with the given key. */
  settings: (overrides?: Partial<SiloSettings>) => SiloSettings;
  reset: () => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  port: () => number;
}

const MONITOR = 'admin:monitor:read';

/** Which scope admits a GET route, as Silo's allowlist does. */
const scopesFor = (path: string): string[] => {
  if (path === '/user/libraries') return ['libraries:read'];
  if (path === '/admin/users/policy-defaults') return ['admin:users'];
  if (path === '/admin/users') return [MONITOR, 'admin:users'];
  if (path === '/admin/catalog/items' || path === '/admin/catalog/capabilities')
    return [MONITOR, 'admin:catalog:paths'];
  if (
    [
      '/admin/playback-history',
      '/admin/sessions',
      '/admin/server/status',
    ].includes(path)
  )
    return [MONITOR];
  return [];
};

const PAGED = new Set([
  '/admin/catalog/items',
  '/admin/playback-history',
  '/admin/users',
  '/admin/sessions',
]);

/** Parameters each GET route takes besides paging. */
const PARAMS: Record<string, string[]> = {
  '/admin/catalog/items': [
    'library_id',
    'type',
    'added_after',
    'content_ids',
    'include_people',
    'include_file_paths',
  ],
  '/admin/playback-history': [
    'user_id',
    'profile_id',
    'media_item_id',
    'completed',
    'ended_after',
    'ended_before',
  ],
  '/admin/users': ['identity'],
  '/admin/sessions': ['user_id'],
  '/user/libraries': ['include_hidden'],
};

const problem = (
  res: http.ServerResponse,
  status: number,
  code: string,
  detail: string
) => {
  res.writeHead(status, { 'Content-Type': 'application/problem+json' });
  res.end(
    JSON.stringify({
      type: `https://siloserver.org/docs/api/v2/problems/${code}`,
      title: code,
      status,
      detail,
      instance: 'urn:silo:request:1',
    })
  );
};

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

export const createFakeSilo = (): FakeSilo => {
  let server: http.Server | undefined;
  let sessions = new Map<string, FakeSiloAccount>();
  let nextKey = 1;

  const fake: FakeSilo = {
    calls: [],
    apiMajor: 2,
    serverVersion: '1.0.0',
    contractDigest: 'a'.repeat(64),
    serverId: '3f2a9d5e-6b1c-4c7e-9a0d-2f4b8c1e7a35',
    serverName: 'Glasswing',
    keys: new Map(),
    accounts: [],
    libraries: [],
    items: [],
    status: {
      started_at: '2026-11-01T00:00:00.000Z',
      restart_required: false,
      health: {
        postgres: { configured: true, ok: true },
        redis: { configured: true, ok: true },
        errors_24h: 0,
        warnings_24h: 0,
      },
    },
    refuseKeyCreation: false,
    rateLimited: 0,
    down: false,
    settings: (overrides = {}) => ({
      ...siloDefaults(),
      name: fake.serverName,
      ip: '127.0.0.1',
      port: fake.port(),
      apiKey: 'sa_test',
      serverId: fake.serverId,
      connected: true,
      ...overrides,
    }),
    reset: () => {
      fake.calls = [];
      fake.apiMajor = 2;
      fake.serverVersion = '1.0.0';
      fake.contractDigest = 'a'.repeat(64);
      fake.keys = new Map([['sa_test', { scopes: [], admin: true }]]);
      fake.accounts = [];
      fake.libraries = [];
      fake.items = [];
      fake.refuseKeyCreation = false;
      fake.rateLimited = 0;
      fake.down = false;
      sessions = new Map();
    },
    port: () => (server?.address() as AddressInfo | null)?.port ?? 0,
    start: async () => {
      fake.reset();
      server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => handle(req, res, raw));
      });
      await new Promise<void>((resolve) =>
        server?.listen(0, '127.0.0.1', resolve)
      );
    },
    stop: async () => {
      await new Promise<void>((resolve) =>
        server ? server.close(() => resolve()) : resolve()
      );
      server = undefined;
    },
  };

  const handle = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    raw: string
  ) => {
    const url = new URL(req.url ?? '/', 'http://silo.test');
    const query = Object.fromEntries(url.searchParams.entries());
    const auth = req.headers.authorization?.replace(/^Bearer /, '');
    let body: Record<string, unknown> | undefined;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return problem(res, 400, 'malformed_body', 'The body is not JSON.');
    }
    if (!url.pathname.startsWith('/api/v2/')) {
      return problem(res, 404, 'not_found', 'No such route.');
    }
    const path = url.pathname.slice('/api/v2'.length);
    fake.calls.push({ method: req.method ?? 'GET', path, query, auth, body });

    if (fake.down) {
      return problem(res, 503, 'unavailable', 'Silo is down.');
    }
    if (fake.rateLimited > 0) {
      fake.rateLimited -= 1;
      res.setHeader('Retry-After', '0');
      return problem(res, 429, 'rate_limited', 'Slow down.');
    }

    // Public routes.
    if (req.method === 'GET' && path === '/system/info') {
      return json(res, 200, {
        server_version: fake.serverVersion,
        api_major: fake.apiMajor,
        contract_digest: fake.contractDigest,
        links: {
          openapi: '/api/v2/openapi.json',
          capabilities: '/api/v2/capabilities',
          identity: '/api/v2/system/identity',
        },
        request_origin: `http://127.0.0.1:${fake.port()}`,
      });
    }
    if (req.method === 'GET' && path === '/system/identity') {
      return json(res, 200, { server_id: fake.serverId });
    }
    if (req.method === 'GET' && path === '/theme/branding') {
      return json(res, 200, {
        server_name: fake.serverName,
        login_subtitle: '',
        storage_available: true,
      });
    }
    if (req.method === 'POST' && path === '/auth/login') {
      const account = fake.accounts.find(
        (a) => a.username === body?.username && a.password === body?.password
      );
      if (!account) {
        return problem(res, 401, 'invalid_credentials', 'No.');
      }
      const token = `session-${account.id}-${sessions.size + 1}`;
      sessions.set(token, account);
      return json(res, 200, {
        access_token: token,
        refresh_token: `refresh-${token}`,
        expires_in: 3600,
        user: {
          id: account.id,
          username: account.username,
          email: '',
          role: account.role,
          permissions: [],
          download_allowed: true,
          password_change_required: false,
        },
      });
    }
    if (req.method === 'POST' && path === '/auth/logout') {
      if (auth) sessions.delete(auth);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'POST' && path === '/admin/api-keys') {
      const account = auth ? sessions.get(auth) : undefined;
      if (!account) {
        return problem(res, 401, 'authentication_required', 'Sign in.');
      }
      if (account.role !== 'admin' || fake.refuseKeyCreation) {
        return problem(res, 403, 'permission_denied', 'Not allowed.');
      }
      const key = `sa_made_${nextKey++}`;
      const scopes = Array.isArray(body?.scopes)
        ? (body?.scopes as string[])
        : [];
      fake.keys.set(key, { scopes, admin: true });
      return json(res, 201, {
        id: String(nextKey),
        user_id: account.id,
        label: body?.label,
        key,
        rate_tier: 'standard',
        scopes,
        created_at: '2026-11-24T00:00:00.000Z',
      });
    }

    // Everything else needs a key.
    const key = auth ? fake.keys.get(auth) : undefined;
    if (!key) {
      return problem(res, 401, 'authentication_required', 'Bad key.');
    }
    if (req.method !== 'GET') {
      return problem(res, 405, 'method_not_allowed', 'Read only here.');
    }
    const admits = scopesFor(path);
    if (
      key.scopes.length &&
      !key.scopes.some((scope) => admits.includes(scope))
    ) {
      return problem(res, 403, 'permission_denied', 'Scope.');
    }
    if (path.startsWith('/admin/') && !key.admin) {
      return problem(res, 403, 'permission_denied', 'Admins only.');
    }
    const allowed = new Set([
      ...(PARAMS[path] ?? []),
      ...(PAGED.has(path) ? ['limit', 'cursor'] : []),
    ]);
    const unknown = Object.keys(query).find((name) => !allowed.has(name));
    if (unknown) {
      return problem(
        res,
        422,
        'unknown_query_parameter',
        `Unknown parameter ${unknown}.`
      );
    }
    if (Number(query.limit ?? 50) > 200 || Number(query.limit ?? 50) < 1) {
      return problem(res, 422, 'validation_failed', 'limit is 1 to 200.');
    }

    const page = <T>(list: T[]) => {
      const limit = Number(query.limit ?? 50);
      const filters = JSON.stringify(
        Object.entries(query).filter(([k]) => k !== 'limit' && k !== 'cursor')
      );
      let offset = 0;
      if (query.cursor) {
        const [bound, at] = Buffer.from(query.cursor, 'base64url')
          .toString()
          .split('|');
        if (bound !== filters) {
          return problem(res, 422, 'invalid_cursor', 'Wrong cursor.');
        }
        offset = Number(at);
      }
      const items = list.slice(offset, offset + limit);
      const more = offset + limit < list.length;
      return json(res, 200, {
        items,
        page: {
          has_more: more,
          ...(more
            ? {
                next_cursor: Buffer.from(
                  `${filters}|${offset + limit}`
                ).toString('base64url'),
              }
            : {}),
        },
      });
    };

    switch (path) {
      case '/user/libraries':
        return json(res, 200, { items: fake.libraries });
      case '/admin/server/status':
        return json(res, 200, fake.status);
      case '/admin/users/policy-defaults':
        return json(res, 200, {});
      case '/admin/catalog/capabilities':
        return json(res, 200, {
          item_listing: true,
          item_listing_max_content_ids: 200,
          item_file_paths:
            !key.scopes.length || key.scopes.includes('admin:catalog:paths'),
          state: 'available',
          allowed: true,
        });
      case '/admin/catalog/items': {
        if (
          query.include_file_paths === 'true' &&
          key.scopes.length &&
          !key.scopes.includes('admin:catalog:paths')
        ) {
          return problem(res, 403, 'permission_denied', 'Paths.');
        }
        const ids = query.content_ids?.split(',');
        if (ids && ids.length > 200) {
          return problem(res, 422, 'validation_failed', 'Too many ids.');
        }
        const after = query.added_after
          ? new Date(query.added_after).getTime()
          : undefined;
        return page(
          fake.items.filter(
            (item) =>
              (!query.library_id ||
                item.library_ids.includes(query.library_id)) &&
              (!query.type || item.type === query.type) &&
              (!ids || ids.includes(item.content_id)) &&
              (after === undefined ||
                new Date(item.added_at).getTime() >= after)
          )
        );
      }
      case '/admin/playback-history':
      case '/admin/users':
      case '/admin/sessions':
        return page([]);
      default:
        return problem(res, 404, 'not_found', 'No such route.');
    }
  };

  return fake;
};

/** Catalog items for tests, with invented titles. */
export const siloMovie = (
  contentId: string,
  {
    tmdbId,
    libraryId = '1',
    resolutions = ['1080p'],
    ranges = [],
    addedAt = '2026-11-01T00:00:00.000Z',
    title = 'Glasswing',
  }: {
    tmdbId?: number;
    libraryId?: string;
    resolutions?: string[];
    ranges?: string[];
    addedAt?: string;
    title?: string;
  } = {}
): SiloCatalogItem => ({
  content_id: contentId,
  type: 'movie',
  title,
  ...(tmdbId ? { tmdb_id: String(tmdbId) } : {}),
  library_ids: [libraryId],
  added_at: addedAt,
  versions: resolutions.map((resolution, i) => ({
    file_id: `${contentId}-f${i}`,
    library_id: libraryId,
    resolution,
    ...(ranges[i] ? { dynamic_range: ranges[i] } : {}),
  })),
});

export const siloSeries = (
  contentId: string,
  {
    tmdbId,
    tvdbId,
    libraryId = '2',
    title = 'Static Garden',
    addedAt = '2026-11-01T00:00:00.000Z',
  }: {
    tmdbId?: number;
    tvdbId?: number;
    libraryId?: string;
    title?: string;
    addedAt?: string;
  } = {}
): SiloCatalogItem => ({
  content_id: contentId,
  type: 'series',
  title,
  ...(tmdbId ? { tmdb_id: String(tmdbId) } : {}),
  ...(tvdbId ? { tvdb_id: String(tvdbId) } : {}),
  library_ids: [libraryId],
  added_at: addedAt,
  versions: [],
});

export const siloEpisode = (
  seriesId: string,
  season: number,
  episode: number,
  {
    libraryId = '2',
    resolutions = ['1080p'],
    ranges = [],
    addedAt = '2026-11-01T00:00:00.000Z',
  }: {
    libraryId?: string;
    resolutions?: string[];
    ranges?: string[];
    addedAt?: string;
  } = {}
): SiloCatalogItem => ({
  content_id: `${seriesId}-${season}-${episode}`,
  type: 'episode',
  title: `Episode ${episode}`,
  series_id: seriesId,
  series_title: 'Static Garden',
  season_number: season,
  episode_number: episode,
  library_ids: [libraryId],
  added_at: addedAt,
  versions: resolutions.map((resolution, i) => ({
    file_id: `${seriesId}-${season}-${episode}-f${i}`,
    library_id: libraryId,
    resolution,
    ...(ranges[i] ? { dynamic_range: ranges[i] } : {}),
  })),
});
