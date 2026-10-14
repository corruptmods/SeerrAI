import PlexAPI from '@server/api/plexapi';
import PlexTvAPI from '@server/api/plextv';
import { MediaStatus, MediaType } from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import { MEDIA_SERVER_KINDS, MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MusicAlbum from '@server/entity/MusicAlbum';
import { User } from '@server/entity/User';
import { scheduledJobs } from '@server/job/schedule';
import availabilitySync from '@server/lib/availabilitySync';
import { signInAllowed } from '@server/lib/mediaServers';
import plexMatchCheck, {
  REPORT_PATH,
  type PlexMatchProblem,
} from '@server/lib/plexMatchCheck';
import { getSettings, jellyfinDefaults } from '@server/lib/settings';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import schedule from 'node-schedule';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { IncomingMessage, Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

/*
 * Settings → Media Servers: connecting Plex, Jellyfin and Emby beside each
 * other, removing them, choosing the primary one and who may sign in with
 * each, against stand-ins that answer as the servers do, behind the real
 * OpenAPI validator.
 */

setupTestDb();

const ADMIN_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VIEWER_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OFF_ADMIN_ID = 'cccccccccccccccccccccccccccccccc';

let jellyfinPort = 0;
let port = 0;
const servers: Server[] = [];

const accounts = [
  { Id: ADMIN_ID, Name: 'den-admin', Policy: { IsAdministrator: true } },
  { Id: VIEWER_ID, Name: 'viewer', Policy: { IsAdministrator: false } },
  {
    Id: OFF_ADMIN_ID,
    Name: 'old-admin',
    Policy: { IsAdministrator: true, IsDisabled: true },
  },
];

/**
 * A stand-in Jellyfin server: "den-admin" (password "secret") is an
 * administrator, "viewer" (password "pw") is not. The key Seerr makes
 * itself, and "given-key", are its API keys.
 */
const jellyfinStandIn = (req: IncomingMessage, res: http.ServerResponse) => {
  const auth = String(req.headers.authorization ?? '');
  const url = new URL(req.url ?? '', 'http://localhost');
  res.setHeader('Content-Type', 'application/json');
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (url.pathname === '/Users/AuthenticateByName') {
      const { Username, Pw } = JSON.parse(body || '{}');
      const account =
        Username === 'den-admin' && Pw === 'secret'
          ? accounts[0]
          : Username === 'viewer' && Pw === 'pw'
            ? accounts[1]
            : undefined;
      if (!account) {
        res.statusCode = 401;
        return res.end('{}');
      }
      return res.end(
        JSON.stringify({
          User: { ...account, ServerId: 'den-jellyfin-id' },
          AccessToken: `${account.Name}-token`,
        })
      );
    }
    if (url.pathname === '/System/Info/Public') {
      return res.end(JSON.stringify({ ServerName: 'Den Jellyfin' }));
    }
    if (url.pathname === '/Auth/Keys') {
      if (!auth.includes('Token="den-admin-token"')) {
        res.statusCode = 401;
        return res.end('{}');
      }
      if (req.method === 'POST') {
        res.statusCode = 204;
        return res.end();
      }
      return res.end(
        JSON.stringify({ Items: [{ AppName: 'Seerr', AccessToken: 'made' }] })
      );
    }
    if (!auth.includes('Token="made"') && !auth.includes('Token="given"')) {
      res.statusCode = 401;
      return res.end('{}');
    }
    if (url.pathname === '/System/Info') {
      return res.end(
        JSON.stringify({ Id: 'den-jellyfin-id', ServerName: 'Den Jellyfin' })
      );
    }
    if (url.pathname === '/Users') {
      return res.end(JSON.stringify(accounts));
    }
    const one = accounts.find((a) => url.pathname === `/Users/${a.Id}`);
    if (one) {
      return res.end(JSON.stringify(one));
    }
    res.statusCode = 404;
    res.end('{}');
  });
};

before(async () => {
  const listen = (app: http.RequestListener) =>
    new Promise<number>((resolve) => {
      const server = http.createServer(app).listen(0, () => {
        resolve((server.address() as AddressInfo).port);
      });
      servers.push(server);
    });

  jellyfinPort = await listen(jellyfinStandIn);

  const app = express();
  app.use(express.json());
  // Signed in as the person the test names, the owner when none.
  app.use(async (req, _res, next) => {
    req.user = await getRepository(User).findOneOrFail({
      where: { id: Number(req.headers['x-test-user'] ?? 1) },
    });
    next();
  });
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.use('/api/v1/settings', settingsRoutes);
  app.use(
    (
      err: { status?: number; message: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
  port = await listen(app);
});

after(() => servers.forEach((server) => server.close()));

/** Stubs an API client's method, however the client defines it. */
const stubbed: { target: object; name: string }[] = [];
const stub = (target: object, name: string, fn: unknown) => {
  Object.defineProperty(target, name, {
    configurable: true,
    set() {},
    get() {
      return fn;
    },
  });
  stubbed.push({ target, name });
};

let availabilitySyncRuns = 0;
const realRun = availabilitySync.run;

beforeEach(() => {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.main.localLogin = true;
  settings.main.mediaServerLogin = true;
  settings.plex = {
    ...settings.plex,
    name: 'Den Plex',
    ip: '127.0.0.1',
    port: 32400,
    machineId: 'den-plex-id',
    libraries: [
      { id: '1', name: 'Films', enabled: true, type: 'movie', lastScan: 5 },
      { id: '2', name: 'Series', enabled: false, type: 'show' },
    ],
    musicLibraries: [],
    connected: true,
    signIn: true,
  };
  settings.jellyfin = jellyfinDefaults();
  settings.emby = jellyfinDefaults();
  availabilitySyncRuns = 0;
  availabilitySync.run = async () => {
    availabilitySyncRuns += 1;
  };
});

afterEach(async () => {
  for (const { target, name } of stubbed.splice(0)) {
    delete (target as Record<string, unknown>)[name];
  }
  availabilitySync.run = realRun;
  await schedule.gracefulShutdown();
  scheduledJobs.length = 0;
});

const api = (
  route: string,
  init?: RequestInit & { as?: number }
): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/api/v1/settings${route}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-test-user': String(init?.as ?? 1),
    },
  });

const post = (route: string, body?: unknown, as?: number) =>
  api(route, { method: 'POST', body: JSON.stringify(body ?? {}), as });

interface Summary {
  kind: MediaServerKind;
  name: string;
  connected: boolean;
  primary: boolean;
  signIn: boolean;
  libraries: number;
  enabledLibraries: number;
  lastScan?: number;
  address: { ip: string; port: number };
  ownerAccount?: string;
}

const byKind = (list: Summary[], kind: MediaServerKind) =>
  list.find((server) => server.kind === kind) as Summary;

/** Connects Jellyfin as Seerr would have, with Seerr's own API key. */
const connectJellyfin = (signIn = true) => {
  getSettings().jellyfin = {
    ...jellyfinDefaults(),
    name: 'Den Jellyfin',
    ip: '127.0.0.1',
    port: jellyfinPort,
    apiKey: 'made',
    serverId: 'den-jellyfin-id',
    connected: true,
    signIn,
  };
};

/** The stand-in Jellyfin server's address, as the connect form sends it. */
const at = () => ({
  hostname: '127.0.0.1',
  port: jellyfinPort,
  useSsl: false,
  urlBase: '',
});

describe('the media servers list', () => {
  it('lists all three, connected or not, without API keys', async () => {
    connectJellyfin();
    await getRepository(User).update(1, { jellyfinUsername: 'den-admin' });

    const res = await api('/media-servers');
    assert.equal(res.status, 200);
    const list = (await res.json()) as Summary[];
    assert.deepEqual(
      list.map((s) => [s.kind, s.connected, s.primary]),
      [
        ['plex', true, true],
        ['jellyfin', true, false],
        ['emby', false, false],
      ]
    );
    const plex = byKind(list, 'plex');
    assert.equal(plex.name, 'Den Plex');
    assert.equal(plex.libraries, 2);
    assert.equal(plex.enabledLibraries, 1);
    assert.equal(plex.lastScan, 5);
    assert.equal(plex.ownerAccount, 'admin');
    assert.equal(byKind(list, 'jellyfin').ownerAccount, 'den-admin');
    assert.ok(!JSON.stringify(list).includes('made'), 'no API key');
  });
});

describe('sign-in with each server', () => {
  it("follows each server's own switch, and keeps the old one in step", async () => {
    connectJellyfin();
    const res = await post('/media-servers/jellyfin/sign-in', {
      signIn: false,
    });
    assert.equal(res.status, 200);
    assert.equal(byKind(await res.json(), 'jellyfin').signIn, false);
    assert.equal(signInAllowed('jellyfin'), false);
    assert.equal(signInAllowed('plex'), true);
    assert.equal(getSettings().main.mediaServerLogin, true, 'Plex allows it');

    await post('/media-servers/plex/sign-in', { signIn: false });
    assert.equal(getSettings().main.mediaServerLogin, false);

    await post('/media-servers/plex/sign-in', { signIn: true });
    assert.equal(getSettings().main.mediaServerLogin, true);
    assert.equal(getSettings().jellyfin.signIn, false, 'left alone');
  });

  it('keeps at least one way to sign in', async () => {
    getSettings().main.localLogin = false;
    const res = await post('/media-servers/plex/sign-in', { signIn: false });
    assert.equal(res.status, 400);
    assert.equal(getSettings().plex.signIn, true);
  });

  it('is only for a connected server', async () => {
    const res = await post('/media-servers/emby/sign-in', { signIn: true });
    assert.equal(res.status, 404);
  });

  it('is changed only here, not from the server settings pages', async () => {
    const res = await post('/plex', {
      ip: '127.0.0.1',
      port: 32400,
      signIn: false,
    });
    assert.equal(res.status, 400);
    assert.equal(getSettings().plex.signIn, true);
  });

  it("saving Settings → Users unchanged leaves each server's switch", async () => {
    connectJellyfin(false);
    const res = await post('/main', { mediaServerLogin: true });
    assert.equal(res.status, 200);
    assert.equal(getSettings().jellyfin.signIn, false);
    assert.equal(getSettings().plex.signIn, true);

    await post('/main', { mediaServerLogin: false });
    assert.equal(getSettings().plex.signIn, false);
    assert.equal(getSettings().main.mediaServerLogin, false);

    await post('/main', { mediaServerLogin: true });
    assert.equal(getSettings().plex.signIn, true);
    assert.equal(getSettings().jellyfin.signIn, true);
  });
});

describe('the primary server', () => {
  it('can be any connected server', async () => {
    connectJellyfin();
    const res = await post('/media-servers/jellyfin/primary');
    assert.equal(res.status, 200);
    assert.equal(getSettings().main.mediaServerType, MediaServerType.JELLYFIN);
    const list = (await res.json()) as Summary[];
    assert.equal(byKind(list, 'jellyfin').primary, true);
    assert.equal(byKind(list, 'plex').primary, false);
    assert.deepEqual(
      getSettings().fullPublicSettings.mediaServers.map((s) => s.kind),
      ['jellyfin', 'plex']
    );

    const notConnected = await post('/media-servers/emby/primary');
    assert.equal(notConnected.status, 404);
    assert.equal(getSettings().main.mediaServerType, MediaServerType.JELLYFIN);
  });
});

describe('connecting Jellyfin or Emby', () => {
  it("signs in as an administrator and makes Seerr's own API key", async () => {
    const res = await post('/media-servers/jellyfin/connect', {
      ...at(),
      username: 'den-admin',
      password: 'secret',
      linkOwner: true,
      signIn: true,
    });
    assert.equal(res.status, 200);
    assert.equal(byKind(await res.json(), 'jellyfin').connected, true);

    const settings = getSettings();
    assert.equal(settings.jellyfin.connected, true);
    assert.equal(settings.jellyfin.apiKey, 'made');
    assert.equal(settings.jellyfin.serverId, 'den-jellyfin-id');
    assert.equal(settings.jellyfin.name, 'Den Jellyfin');
    assert.equal(settings.jellyfin.adminUserId, ADMIN_ID);
    assert.equal(settings.main.mediaServerType, MediaServerType.PLEX);

    // Linked to the owner, who stays a Plex account with their own email.
    const owner = await getRepository(User).findOneOrFail({
      where: { id: 1 },
      select: [
        'id',
        'email',
        'userType',
        'jellyfinUserId',
        'jellyfinUsername',
        'jellyfinDeviceId',
      ],
    });
    assert.equal(owner.jellyfinUserId, ADMIN_ID);
    assert.equal(owner.jellyfinUsername, 'den-admin');
    assert.equal(owner.jellyfinDeviceId, 'BOT_seerr');
    assert.equal(owner.userType, UserType.PLEX);
    assert.equal(owner.email, 'admin@seerr.dev');

    // Its scans started, beside Plex's.
    const ids = scheduledJobs.map((job) => job.id);
    assert.ok(ids.includes('jellyfin-recently-added-scan'));
    assert.ok(ids.includes('plex-recently-added-scan'));

    const again = await post('/media-servers/jellyfin/connect', {
      ...at(),
      username: 'den-admin',
      password: 'secret',
    });
    assert.equal(again.status, 409, 'already connected');
  });

  it('refuses an account that is not an administrator, or a wrong password', async () => {
    const viewer = await post('/media-servers/jellyfin/connect', {
      ...at(),
      username: 'viewer',
      password: 'pw',
    });
    assert.equal(viewer.status, 403);
    assert.equal((await viewer.json()).message, 'NOT_ADMIN');

    const wrong = await post('/media-servers/jellyfin/connect', {
      ...at(),
      username: 'den-admin',
      password: 'nope',
    });
    assert.equal(wrong.status, 401);
    assert.equal(getSettings().jellyfin.connected, false);
  });

  it('does not link an account someone else has, nor for anyone but the owner', async () => {
    await getRepository(User).update(2, { jellyfinUserId: ADMIN_ID });
    const taken = await post('/media-servers/jellyfin/connect', {
      ...at(),
      username: 'den-admin',
      password: 'secret',
      linkOwner: true,
    });
    assert.equal(taken.status, 409);
    assert.equal(getSettings().jellyfin.connected, false);

    await getRepository(User).update(2, {
      jellyfinUserId: null,
      permissions: 2,
    });
    const notOwner = await post(
      '/media-servers/jellyfin/connect',
      {
        ...at(),
        username: 'den-admin',
        password: 'secret',
        linkOwner: true,
      },
      2
    );
    assert.equal(notOwner.status, 403);
  });

  it('connects Emby with an API key and a chosen administrator', async () => {
    getSettings().emby = {
      ...jellyfinDefaults(),
      serverId: 'an-older-server',
      libraries: [{ id: 'x', name: 'Old', enabled: true, type: 'movie' }],
    };

    const admins = await post('/media-servers/emby/admins', {
      ...at(),
      apiKey: 'given',
    });
    assert.equal(admins.status, 200);
    assert.deepEqual(await admins.json(), [
      { id: ADMIN_ID, name: 'den-admin' },
    ]);

    const badKey = await post('/media-servers/emby/admins', {
      ...at(),
      apiKey: 'wrong',
    });
    assert.equal(badKey.status, 401);

    const notAdmin = await post('/media-servers/emby/connect', {
      ...at(),
      apiKey: 'given',
      adminUserId: VIEWER_ID,
    });
    assert.equal(notAdmin.status, 403);

    const res = await post('/media-servers/emby/connect', {
      ...at(),
      apiKey: 'given',
      adminUserId: ADMIN_ID,
      signIn: false,
    });
    assert.equal(res.status, 200);
    const emby = getSettings().emby;
    assert.equal(emby.connected, true);
    assert.equal(emby.apiKey, 'given');
    assert.equal(emby.adminUserId, ADMIN_ID);
    assert.equal(emby.signIn, false);
    assert.deepEqual(emby.libraries, [], "another server's libraries go");
    assert.equal(signInAllowed('emby'), false);
    const owner = await getRepository(User).findOneOrFail({
      where: { id: 1 },
      select: ['id', 'embyUserId'],
    });
    assert.equal(owner.embyUserId, null, 'not linked unless asked');
    assert.ok(scheduledJobs.some((job) => job.id === 'emby-full-scan'));
  });

  it('does not connect one server as both Jellyfin and Emby', async () => {
    connectJellyfin();
    const res = await post('/media-servers/emby/connect', {
      ...at(),
      apiKey: 'given',
      adminUserId: ADMIN_ID,
    });
    assert.equal(res.status, 409);
  });
});

describe('connecting Plex', () => {
  beforeEach(() => {
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.JELLYFIN;
    connectJellyfin();
    settings.plex.connected = false;
  });

  it("links the owner's Plex account, then reaches the server with it", async () => {
    stub(PlexTvAPI.prototype, 'getUser', async () => ({
      id: 777,
      username: 'den-owner',
      email: 'someone-else@example.com',
      authToken: 'owner-plex-token',
    }));
    let reachedWith: string | undefined;
    stub(PlexAPI.prototype, 'getStatus', async function (this: PlexAPI) {
      reachedWith = (
        this as unknown as { axios: { defaults: { baseURL: string } } }
      ).axios.defaults.baseURL;
      return {
        MediaContainer: {
          machineIdentifier: 'den-plex-id',
          friendlyName: 'Den Plex',
        },
      };
    });

    const linked = await post('/media-servers/plex/account', {
      authToken: 'from-plex-sign-in',
    });
    assert.equal(linked.status, 200);
    assert.equal((await linked.json()).plexUsername, 'den-owner');
    const owner = await getRepository(User).findOneOrFail({
      where: { id: 1 },
      select: ['id', 'email', 'userType', 'plexId', 'plexToken'],
    });
    assert.equal(owner.plexId, 777);
    assert.equal(owner.plexToken, 'owner-plex-token');
    assert.equal(owner.email, 'admin@seerr.dev', 'email untouched');

    const res = await post('/media-servers/plex/connect', {
      hostname: '10.0.0.5',
      port: 32400,
      useSsl: false,
    });
    assert.equal(res.status, 200);
    assert.equal(reachedWith, 'http://10.0.0.5:32400');
    const plex = getSettings().plex;
    assert.equal(plex.connected, true);
    assert.equal(plex.ip, '10.0.0.5');
    assert.equal(plex.libraries.length, 2, 'the same server keeps its own');
    assert.equal(
      getSettings().main.mediaServerType,
      MediaServerType.JELLYFIN,
      'still primary'
    );
    assert.ok(scheduledJobs.some((job) => job.id === 'plex-full-scan'));
  });

  it("refuses a Plex account that is someone else's", async () => {
    await getRepository(User).update(2, { plexId: 888 });
    stub(PlexTvAPI.prototype, 'getUser', async () => ({
      id: 888,
      username: 'friend',
      authToken: 't',
    }));
    const res = await post('/media-servers/plex/account', { authToken: 'x' });
    assert.equal(res.status, 409);
  });

  it('is only for the owner', async () => {
    await getRepository(User).update(2, { permissions: 2 });
    const account = await post(
      '/media-servers/plex/account',
      { authToken: 'x' },
      2
    );
    assert.equal(account.status, 403);
    const connect = await post(
      '/media-servers/plex/connect',
      { hostname: '10.0.0.5', port: 32400 },
      2
    );
    assert.equal(connect.status, 403);
    assert.equal(getSettings().plex.connected, false);
  });

  it('says when the server cannot be reached', async () => {
    stub(PlexAPI.prototype, 'getStatus', async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await post('/media-servers/plex/connect', {
      hostname: '10.0.0.6',
      port: 32400,
    });
    assert.equal(res.status, 502);
    assert.equal(getSettings().plex.connected, false);
  });
});

describe('removing a server', () => {
  const problem = (mediaServer: PlexMatchProblem['mediaServer']) => ({
    kind: 'movie' as const,
    folder: `/films/${mediaServer}`,
    expected: { title: mediaServer, server: 'Radarr' },
    mediaServer,
    matched: { title: 'Other', key: '1' },
    reason: 'other' as const,
  });

  afterEach(() => fs.rm(REPORT_PATH, { force: true }));

  it('cannot remove the last one', async () => {
    const res = await api('/media-servers/plex', { method: 'DELETE' });
    assert.equal(res.status, 400);
    assert.equal(getSettings().plex.connected, true);
  });

  it('disconnects it and undoes its part, keeping what reconnecting needs', async () => {
    connectJellyfin();
    const media = getRepository(Media);
    const both = await media.save(
      new Media({
        tmdbId: 1,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        ratingKey: 'p1',
        ratingKey4k: 'p1-4k',
        jellyfinMediaId: 'j1',
      })
    );
    const jellyfinOnly = await media.save(
      new Media({
        tmdbId: 2,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        jellyfinMediaId: 'j2',
        jellyfinMediaId4k: 'j2-4k',
      })
    );
    const artist = await media.save(
      new Media({ tmdbId: 0, mediaType: MediaType.MUSIC })
    );
    const album = await getRepository(MusicAlbum).save(
      new MusicAlbum({
        mediaId: artist.id,
        title: 'An Album',
        ratingKey: 'pa',
        jellyfinItemId: 'ja',
      })
    );
    await getRepository(User).update(2, { jellyfinUserId: VIEWER_ID });
    (plexMatchCheck as unknown as { report: unknown }).report = {
      finishedAt: null,
      running: false,
      checked: 2,
      notChecked: 0,
      problems: [problem('Plex'), problem('Jellyfin')],
    };
    const { refreshMediaServerJobs } = await import('@server/job/schedule');
    refreshMediaServerJobs();
    assert.ok(scheduledJobs.some((job) => job.server === 'jellyfin'));

    const res = await api('/media-servers/jellyfin', { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(byKind(await res.json(), 'jellyfin').connected, false);

    const jellyfin = getSettings().jellyfin;
    assert.equal(jellyfin.connected, false);
    assert.equal(jellyfin.apiKey, '', 'its API key is forgotten');
    assert.equal(jellyfin.ip, '127.0.0.1', 'its address is kept');
    assert.equal(jellyfin.serverId, 'den-jellyfin-id');

    const after1 = await media.findOneByOrFail({ id: both.id });
    assert.equal(after1.jellyfinMediaId, null);
    assert.equal(after1.ratingKey, 'p1', "Plex's ids stay");
    assert.equal(after1.ratingKey4k, 'p1-4k');
    const after2 = await media.findOneByOrFail({ id: jellyfinOnly.id });
    assert.equal(after2.jellyfinMediaId, null);
    assert.equal(after2.jellyfinMediaId4k, null);
    const albumAfter = await getRepository(MusicAlbum).findOneByOrFail({
      id: album.id,
    });
    assert.equal(albumAfter.jellyfinItemId, null);
    assert.equal(albumAfter.ratingKey, 'pa');

    const report = await plexMatchCheck.lastReport();
    assert.deepEqual(
      report.problems.map((p) => p.mediaServer),
      ['Plex']
    );
    assert.ok(!scheduledJobs.some((job) => job.server === 'jellyfin'));
    assert.ok(scheduledJobs.some((job) => job.server === 'plex'));
    assert.equal(availabilitySyncRuns, 1);

    // People's accounts on it stay, unused.
    const friend = await getRepository(User).findOneOrFail({
      where: { id: 2 },
      select: ['id', 'jellyfinUserId'],
    });
    assert.equal(friend.jellyfinUserId, VIEWER_ID);
    assert.equal(signInAllowed('jellyfin'), false);
  });

  it('makes the next connected server primary when the primary goes', async () => {
    connectJellyfin();
    getSettings().emby = { ...getSettings().jellyfin, connected: true };
    const res = await api('/media-servers/plex', { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(getSettings().main.mediaServerType, MediaServerType.JELLYFIN);
    assert.equal(getSettings().plex.connected, false);
    assert.equal(getSettings().plex.machineId, 'den-plex-id');
  });

  it('says how many people could then sign in only with a password, or not at all', async () => {
    connectJellyfin();
    const users = getRepository(User);
    // Owner (1): Plex and Jellyfin, with a password: unaffected.
    await users.update(1, { jellyfinUserId: ADMIN_ID });
    // Friend (2): Jellyfin only, with a password: password only.
    await users.update(2, { jellyfinUserId: VIEWER_ID, plexId: null });
    // Three: Jellyfin only, no password: not at all.
    await users.save(
      new User({
        email: 'three@seerr.dev',
        userType: UserType.JELLYFIN,
        jellyfinUserId: OFF_ADMIN_ID,
        permissions: 0,
        avatar: '',
      })
    );
    // Four: Jellyfin and Plex, with no password: unaffected while Plex
    // allows sign-in.
    await users.save(
      new User({
        email: 'four@seerr.dev',
        userType: UserType.JELLYFIN,
        jellyfinUserId: 'dddddddddddddddddddddddddddddddd',
        plexId: 4,
        permissions: 0,
        avatar: '',
      })
    );

    const res = await api('/media-servers/jellyfin/removal');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { passwordOnly: 1, noSignIn: 1 });

    getSettings().plex.signIn = false;
    assert.deepEqual(
      await (await api('/media-servers/jellyfin/removal')).json(),
      { passwordOnly: 2, noSignIn: 2 },
      "with Plex's sign-in off, the owner and Four depend on Jellyfin too"
    );

    getSettings().main.localLogin = false;
    assert.deepEqual(
      await (await api('/media-servers/jellyfin/removal')).json(),
      { passwordOnly: 1, noSignIn: 3 },
      'without password sign-in, only the owner may use theirs'
    );
  });
});

describe('every kind', () => {
  it('has its own routes', async () => {
    for (const kind of MEDIA_SERVER_KINDS) {
      const res = await api(`/media-servers/${kind}/removal`);
      assert.equal(res.status, 200, kind);
    }
    const unknown = await api('/media-servers/kodi/removal');
    assert.equal(unknown.status, 400, 'refused by the API spec');
  });
});
