import type {
  SiloAccountProfile,
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
 * records every call. Sign-in follows Silo's: a password sign-in or a
 * device code someone approves, a name locked after too many tries (429), a
 * temporary password flagged on the account. Pictures are served outside
 * /api/v2, some only with the key, as Silo's own and signed addresses are.
 */

export interface FakeSiloCall {
  method: string;
  path: string;
  /** Each parameter's last value. */
  query: Record<string, string>;
  /** Each parameter's every value, for those sent more than once. */
  queryAll: Record<string, string[]>;
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
  email?: string;
  /** Default true. A disabled account can't sign in. */
  enabled?: boolean;
  /** Holds a temporary password it must change first. */
  passwordChangeRequired?: boolean;
  profiles?: SiloAccountProfile[];
  /** Its own library allowlist; null for every library (the default). */
  libraryIds?: string[] | null;
  /** Its access group's libraries, when it sets none of its own. */
  groupLibraryIds?: string[] | null;
}

/**
 * A finished play as Silo stores it. Titles and episode numbers are joined
 * from `items` when listed, as Silo joins its live catalog.
 */
export interface FakeSiloPlay {
  session_id: string;
  user_id: string;
  profile_id?: string;
  media_item_id: string;
  ended_at: string;
  end_position_seconds?: number;
  duration_seconds?: number;
  completed: boolean;
  /** Default 'stopped'. */
  end_reason?: string;
}

/** Something playing now. */
export interface FakeSiloPlaying {
  session_id: string;
  user_id: string;
  profile_id?: string;
  media_item_id?: string;
  paused?: boolean;
}

/** A device sign-in Seerr AI started. */
export interface FakeSiloDevice {
  deviceCode: string;
  userCode: string;
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';
  opened: boolean;
  accountId?: string;
  profileId?: string;
}

/** A picture served outside /api/v2. */
export interface FakeSiloPicture {
  contentType: string;
  body: Buffer;
  /** Only with a valid key, as Silo's own paths. */
  needsKey?: boolean;
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
  /** Finished plays (/admin/playback-history). */
  plays: FakeSiloPlay[];
  /** Called after each page of playback history is sent. */
  afterHistoryPage?: () => void;
  /** What is playing now (/admin/sessions). */
  playing: FakeSiloPlaying[];
  status: SiloServerStatus;
  /** Device sign-ins, by device code. */
  devices: Map<string, FakeSiloDevice>;
  /** Pictures by path (with its query, if any). */
  pictures: Map<string, FakeSiloPicture>;
  /** Names Silo locked after too many sign-in attempts (429). */
  lockedNames: Set<string>;
  /** Sign-in sessions still open, by access token. */
  openSessions: () => string[];
  /**
   * Approves a device code as an account (and a profile), as /activate does.
   * The poll names no profile, as Silo names one only for a temporary
   * session.
   */
  approveDevice: (
    userCode: string,
    accountId: string,
    profileId?: string
  ) => void;
  denyDevice: (userCode: string) => void;
  /** Silo refuses to create keys (a household PIN rule, say). */
  refuseKeyCreation: boolean;
  /** Keys Silo mints can't read admin routes (so probes fail). */
  mintNonAdminKeys: boolean;
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

/** One account's routes, by their OpenAPI template. */
const ACCOUNT_ROUTE = /^\/admin\/users\/([^/]+)(\/profiles)?$/;
const templateOf = (path: string): string => {
  const account = ACCOUNT_ROUTE.exec(path);
  if (!account || account[1] === 'policy-defaults') return path;
  return account[2] ? '/admin/users/{id}/profiles' : '/admin/users/{id}';
};

/** Which scope admits a GET route, as Silo's allowlist does. */
const scopesFor = (path: string): string[] => {
  if (path === '/user/libraries') return ['libraries:read'];
  if (path === '/admin/users/policy-defaults') return ['admin:users'];
  if (
    path === '/admin/users' ||
    path === '/admin/users/{id}' ||
    path === '/admin/users/{id}/profiles'
  )
    return [MONITOR, 'admin:users'];
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
  let nextCode = 1;
  /** Keys Silo minted, by their id. */
  const keyIds = new Map<string, string>();

  const deviceByUserCode = (userCode: string) =>
    [...fake.devices.values()].find(
      (device) =>
        device.userCode.replace(/\D/g, '') === userCode.replace(/\D/g, '')
    );

  const accountView = (account: FakeSiloAccount) => ({
    id: account.id,
    username: account.username,
    email: account.email ?? '',
    role: account.role,
    permissions: [],
    download_allowed: true,
    password_change_required: !!account.passwordChangeRequired,
  });

  const openSession = (account: FakeSiloAccount) => {
    const token = `session-${account.id}-${nextCode++}`;
    sessions.set(token, account);
    return {
      access_token: token,
      refresh_token: `refresh-${token}`,
      expires_in: 3600,
      user: accountView(account),
    };
  };

  const fake: FakeSilo = {
    calls: [],
    apiMajor: 2,
    serverVersion: '1.0.0',
    contractDigest: 'a'.repeat(64),
    serverId: '3f2a9d5e-6b1c-4c7e-9a0d-2f4b8c1e7a35',
    serverName: 'Glasswing',
    keys: new Map(),
    accounts: [],
    devices: new Map(),
    pictures: new Map(),
    lockedNames: new Set(),
    openSessions: () => [...sessions.keys()],
    approveDevice: (userCode, accountId, profileId) => {
      const device = deviceByUserCode(userCode);
      if (!device) throw new Error(`No device code ${userCode}`);
      Object.assign(device, {
        status: 'approved',
        opened: true,
        accountId,
        profileId,
      });
    },
    denyDevice: (userCode) => {
      const device = deviceByUserCode(userCode);
      if (device) device.status = 'denied';
    },
    libraries: [],
    items: [],
    plays: [],
    playing: [],
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
    mintNonAdminKeys: false,
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
      // Settings merge, so an unset mark must be written as empty.
      historyCopiedTo: '',
      ...overrides,
    }),
    reset: () => {
      fake.calls = [];
      fake.apiMajor = 2;
      fake.serverVersion = '1.0.0';
      fake.contractDigest = 'a'.repeat(64);
      fake.serverId = '3f2a9d5e-6b1c-4c7e-9a0d-2f4b8c1e7a35';
      fake.keys = new Map([['sa_test', { scopes: [], admin: true }]]);
      fake.accounts = [];
      fake.devices = new Map();
      fake.pictures = new Map();
      fake.lockedNames = new Set();
      fake.libraries = [];
      fake.items = [];
      fake.plays = [];
      fake.afterHistoryPage = undefined;
      fake.playing = [];
      fake.refuseKeyCreation = false;
      fake.mintNonAdminKeys = false;
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
    const queryAll: Record<string, string[]> = {};
    for (const name of url.searchParams.keys()) {
      queryAll[name] = url.searchParams.getAll(name);
    }
    const auth = req.headers.authorization?.replace(/^Bearer /, '');
    let body: Record<string, unknown> | undefined;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return problem(res, 400, 'malformed_body', 'The body is not JSON.');
    }
    if (!url.pathname.startsWith('/api/v2/')) {
      const picture = fake.pictures.get(`${url.pathname}${url.search}`);
      fake.calls.push({
        method: req.method ?? 'GET',
        path: url.pathname,
        query,
        queryAll,
        auth,
      });
      if (!picture || (picture.needsKey && !(auth && fake.keys.has(auth)))) {
        return problem(res, 404, 'not_found', 'No such picture.');
      }
      res.writeHead(200, {
        'Content-Type': picture.contentType,
        'Content-Length': picture.body.length,
      });
      return res.end(picture.body);
    }
    const path = url.pathname.slice('/api/v2'.length);
    fake.calls.push({
      method: req.method ?? 'GET',
      path,
      query,
      queryAll,
      auth,
      body,
    });

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
      if (
        typeof body?.username !== 'string' ||
        typeof body?.password !== 'string' ||
        Object.keys(body).some(
          (name) => !['username', 'password', 'provider'].includes(name)
        )
      ) {
        return problem(res, 422, 'validation_failed', 'Bad body.');
      }
      if (fake.lockedNames.has(body.username)) {
        res.setHeader('Retry-After', '60');
        return problem(res, 429, 'rate_limited', 'Too many tries.');
      }
      const account = fake.accounts.find(
        (a) =>
          a.username === body.username &&
          a.password === body.password &&
          a.enabled !== false
      );
      if (!account) {
        return problem(res, 401, 'invalid_credentials', 'No.');
      }
      return json(res, 200, openSession(account));
    }
    if (req.method === 'POST' && path === '/auth/device/start') {
      const code = String(48217730 + nextCode++);
      const device: FakeSiloDevice = {
        deviceCode: `device-${code}`,
        userCode: `${code.slice(0, 4)}-${code.slice(4)}`,
        status: 'pending',
        opened: false,
      };
      fake.devices.set(device.deviceCode, device);
      const activate = `http://127.0.0.1:${fake.port()}/activate`;
      return json(res, 201, {
        device_code: device.deviceCode,
        user_code: device.userCode,
        match_code: 'lantern harbour',
        verification_uri: activate,
        verification_uri_complete: `${activate}?code=${code}`,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
        expires_in: 900,
        interval: 5,
        device_name: String(body?.device_name ?? ''),
        device_platform: String(body?.device_platform ?? ''),
        client_purpose: 'device_login',
        temporary: false,
      });
    }
    if (req.method === 'POST' && path === '/auth/device/poll') {
      const device = fake.devices.get(String(body?.device_code ?? ''));
      if (!device) {
        return problem(res, 404, 'not_found', 'No such request.');
      }
      const answer = {
        opened: device.opened,
        poll_after: 5,
        profile_id: '',
        profile_token: '',
        temporary: false,
      };
      if (device.status !== 'approved') {
        return json(res, 200, { ...answer, status: device.status });
      }
      device.status = 'consumed';
      const account = fake.accounts.find((a) => a.id === device.accountId);
      if (!account) {
        return problem(res, 404, 'not_found', 'No such account.');
      }
      return json(res, 200, {
        ...answer,
        status: 'approved',
        // Silo names a profile only for temporary sessions.
        profile_id: '',
        tokens: openSession(account),
      });
    }
    if (req.method === 'POST' && path === '/auth/device/cancel') {
      const device = fake.devices.get(String(body?.device_code ?? ''));
      if (device && device.status === 'pending') device.status = 'expired';
      return json(res, 200, { status: 'canceled' });
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
      const id = String(nextKey);
      const key = `sa_made_${nextKey++}`;
      const scopes = Array.isArray(body?.scopes)
        ? (body?.scopes as string[])
        : [];
      fake.keys.set(key, { scopes, admin: !fake.mintNonAdminKeys });
      keyIds.set(id, key);
      return json(res, 201, {
        id,
        user_id: account.id,
        label: body?.label,
        key,
        rate_tier: 'standard',
        scopes,
        created_at: '2026-11-24T00:00:00.000Z',
      });
    }

    const keyRoute = /^\/admin\/api-keys\/([^/]+)$/.exec(path);
    if (req.method === 'DELETE' && keyRoute) {
      const account = auth ? sessions.get(auth) : undefined;
      if (!account || account.role !== 'admin') {
        return problem(res, 401, 'authentication_required', 'Sign in.');
      }
      if (!req.headers['if-match']) {
        return problem(res, 428, 'precondition_required', 'Send If-Match.');
      }
      const made = keyIds.get(keyRoute[1]);
      if (!made) return problem(res, 404, 'not_found', 'No such key.');
      fake.keys.delete(made);
      keyIds.delete(keyRoute[1]);
      res.writeHead(204);
      return res.end();
    }

    // Everything else needs a key.
    const key = auth ? fake.keys.get(auth) : undefined;
    if (!key) {
      return problem(res, 401, 'authentication_required', 'Bad key.');
    }
    if (req.method !== 'GET') {
      return problem(res, 405, 'method_not_allowed', 'Read only here.');
    }
    const route = templateOf(path);
    const admits = scopesFor(route);
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
      ...(PARAMS[route] ?? []),
      ...(PAGED.has(route) ? ['limit', 'cursor'] : []),
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
        Object.entries(queryAll).filter(
          ([k]) => k !== 'limit' && k !== 'cursor'
        )
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

    const adminUser = (account: FakeSiloAccount) => ({
      id: account.id,
      username: account.username,
      email: account.email ?? '',
      role: account.role,
      enabled: account.enabled !== false,
      is_owner: account.id === fake.accounts[0]?.id,
      library_ids: account.libraryIds ?? null,
      password_change_required: !!account.passwordChangeRequired,
      effective_policy: {
        // An admin sees every library; null inherits the group's (all here).
        library_ids:
          account.role === 'admin'
            ? null
            : account.libraryIds === undefined
              ? (account.groupLibraryIds ?? null)
              : account.libraryIds,
      },
    });

    /**
     * A play as Silo lists it: titles, type and episode numbers come from
     * the catalog as it is now, and are blank once the item is gone.
     */
    const historyRow = (play: FakeSiloPlay) => {
      const item = fake.items.find((i) => i.content_id === play.media_item_id);
      const series = item?.series_id
        ? fake.items.find((i) => i.content_id === item.series_id)
        : undefined;
      const account = fake.accounts.find((a) => a.id === play.user_id);
      const profile = account?.profiles?.find((p) => p.id === play.profile_id);
      return {
        session_id: play.session_id,
        user_id: play.user_id,
        username: account?.username ?? '',
        profile_id: play.profile_id ?? '',
        profile_name: profile?.name ?? play.profile_id ?? '',
        media_item_id: play.media_item_id,
        media_file_id: '1',
        media_title: item?.title ?? '',
        media_type: item?.type ?? '',
        play_method: 'direct',
        started_at: play.ended_at,
        ended_at: play.ended_at,
        end_position_seconds: play.end_position_seconds ?? 0,
        duration_seconds: play.duration_seconds ?? null,
        completed: play.completed,
        played_seconds: null,
        series_title: item?.type === 'episode' ? (series?.title ?? '') : '',
        season_number: item?.season_number ?? null,
        episode_number: item?.episode_number ?? null,
        measured: false,
        start_position_seconds: null,
        paused_seconds: null,
        measured_since: null,
        measured_until: null,
        client_ip: null,
        device_id: null,
        device_platform: null,
        client_name: null,
        client_version: null,
        video_decision: null,
        audio_decision: null,
        end_reason: play.end_reason ?? 'stopped',
        subtitle: null,
        lifecycle_seq: null,
      };
    };

    /** A live session as Silo lists it, titled from the catalog. */
    const sessionRow = (session: FakeSiloPlaying) => {
      const item = fake.items.find(
        (i) => i.content_id === session.media_item_id
      );
      const series = item?.series_id
        ? fake.items.find((i) => i.content_id === item.series_id)
        : undefined;
      return {
        session_id: session.session_id,
        user_id: session.user_id,
        username:
          fake.accounts.find((a) => a.id === session.user_id)?.username ?? '',
        profile_id: session.profile_id ?? '',
        profile_name: session.profile_id ?? '',
        media_file_id: '1',
        requested_media_file_id: '1',
        ...(session.media_item_id
          ? { media_item_id: session.media_item_id }
          : {}),
        media_title: item?.title ?? '',
        media_type: item?.type ?? '',
        ...(item?.type === 'episode'
          ? {
              series_title: series?.title ?? '',
              season_number: item.season_number,
              episode_number: item.episode_number,
            }
          : {}),
        play_method: 'direct',
        reporting_node: 'local',
        file_duration: 3600,
        started_at: '2026-11-24T00:00:00.000Z',
        updated_at: '2026-11-24T00:00:00.000Z',
        position_seconds: 60,
        is_paused: !!session.paused,
        has_playback_control: true,
        stream_location: 'local',
        audio_track_index: 0,
        transcode_audio: false,
        stream_bitrate_kbps: null,
        target_bitrate_kbps: null,
        source_bitrate_kbps: null,
        source_audio_channels: null,
        subtitle: null,
      };
    };

    switch (route) {
      case '/admin/users/{id}':
      case '/admin/users/{id}/profiles': {
        const id = decodeURIComponent(ACCOUNT_ROUTE.exec(path)?.[1] ?? '');
        const account = fake.accounts.find((a) => a.id === id);
        if (!account) {
          return problem(res, 404, 'not_found', 'No such account.');
        }
        return route === '/admin/users/{id}'
          ? json(res, 200, adminUser(account))
          : json(res, 200, { items: account.profiles ?? [] });
      }
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
        // One parameter per id (explode); a comma is part of the id.
        const ids = queryAll.content_ids;
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
      case '/admin/users':
        return page(fake.accounts.map(adminUser));
      case '/admin/playback-history': {
        const limit = Number(query.limit ?? 50);
        const filters = JSON.stringify(
          Object.entries(queryAll).filter(
            ([k]) => k !== 'limit' && k !== 'cursor'
          )
        );
        // Keyset paging as Silo's: newest ended first, session id breaking
        // ties, each page strictly after the last row of the one before.
        let after: { at: number; id: string } | undefined;
        if (query.cursor) {
          const [bound, at, id] = Buffer.from(query.cursor, 'base64url')
            .toString()
            .split('|');
          if (bound !== filters) {
            return problem(res, 422, 'invalid_cursor', 'Wrong cursor.');
          }
          after = { at: Number(at), id };
        }
        const time = (value?: string) =>
          value === undefined ? undefined : new Date(value).getTime();
        const from = time(query.ended_after);
        const until = time(query.ended_before);
        if (
          (from !== undefined && Number.isNaN(from)) ||
          (until !== undefined && Number.isNaN(until))
        ) {
          return problem(res, 422, 'validation_failed', 'Bad time.');
        }
        const sorted = fake.plays
          .map((play) => ({ play, at: new Date(play.ended_at).getTime() }))
          .filter(
            ({ play, at }) =>
              (!query.user_id || play.user_id === query.user_id) &&
              (!query.profile_id || play.profile_id === query.profile_id) &&
              (!query.media_item_id ||
                play.media_item_id === query.media_item_id) &&
              (!query.completed ||
                query.completed === 'all' ||
                String(play.completed) === query.completed) &&
              (from === undefined || at >= from) &&
              (until === undefined || at < until) &&
              (!after ||
                at < after.at ||
                (at === after.at && play.session_id < after.id))
          )
          .sort((a, b) =>
            b.at !== a.at
              ? b.at - a.at
              : b.play.session_id < a.play.session_id
                ? -1
                : 1
          );
        const rows = sorted.slice(0, limit);
        const more = sorted.length > limit;
        const last = rows[rows.length - 1];
        json(res, 200, {
          items: rows.map(({ play }) => historyRow(play)),
          page: {
            has_more: more,
            ...(more && last
              ? {
                  next_cursor: Buffer.from(
                    `${filters}|${last.at}|${last.play.session_id}`
                  ).toString('base64url'),
                }
              : {}),
          },
        });
        fake.afterHistoryPage?.();
        return;
      }
      case '/admin/sessions':
        return page(
          fake.playing
            .filter((s) => !query.user_id || s.user_id === query.user_id)
            .map(sessionRow)
        );
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
