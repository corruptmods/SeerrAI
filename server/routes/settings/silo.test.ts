import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { Session } from '@server/entity/Session';
import SiloEpisode from '@server/entity/SiloEpisode';
import SiloPlay from '@server/entity/SiloPlay';
import { User } from '@server/entity/User';
import { scheduledJobs } from '@server/job/schedule';
import availabilitySync from '@server/lib/availabilitySync';
import matchWatch from '@server/lib/matchWatch';
import {
  connectedServers,
  signInAllowed,
  signInOffered,
} from '@server/lib/mediaServers';
import { Permission } from '@server/lib/permissions';
import plexMatchCheck from '@server/lib/plexMatchCheck';
import { siloFullScanner } from '@server/lib/scanners/silo';
import { getSettings, siloDefaults } from '@server/lib/settings';
import { noteSiloResetMarked } from '@server/lib/silo';
import {
  SiloSignInError,
  resetSiloIdentityForTests,
  siloPasswordSignIn,
} from '@server/lib/siloAccounts';
import {
  SILO_LINKS_RESET,
  finishSiloReset,
  forgetPreviousSilo,
} from '@server/lib/siloConnect';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import { createFakeSilo, siloMovie } from '@server/test/fakeSilo';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import schedule from 'node-schedule';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { IsNull, Not } from 'typeorm';

/*
 * Connecting Silo beside Plex (Settings → Media Servers), and its own page
 * (Settings → Silo), against a stand-in Silo behind the real OpenAPI
 * validator.
 */

setupTestDb();

const silo = createFakeSilo();
let port = 0;
let server: Server;
const realRun = availabilitySync.run;

before(async () => {
  await silo.start();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    req.user = await getRepository(User).findOneOrFail({ where: { id: 1 } });
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
  await new Promise<void>((resolve) => {
    server = http.createServer(app).listen(0, () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

after(async () => {
  server.close();
  await silo.stop();
});

beforeEach(() => {
  silo.reset();
  silo.libraries = [
    { id: '1', name: 'Films', type: 'movies', sort_order: 2 },
    { id: '2', name: 'Series', type: 'series', sort_order: 1 },
    { id: '3', name: 'Everything', type: 'mixed', sort_order: 3 },
    { id: '4', name: 'Audiobooks', type: 'audiobooks', sort_order: 4 },
    { id: '5', name: 'Comics', type: 'manga', sort_order: 5 },
  ];
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.main.localLogin = true;
  settings.main.mediaServerLogin = true;
  settings.plex = {
    ...settings.plex,
    name: 'Harbour Lights',
    ip: '127.0.0.1',
    port: 32400,
    machineId: 'harbour-plex',
    libraries: [],
    musicLibraries: [],
    connected: true,
    signIn: true,
  };
  settings.silo = siloDefaults();
  availabilitySync.run = async () => undefined;
});

afterEach(async () => {
  availabilitySync.run = realRun;
  await schedule.gracefulShutdown();
  scheduledJobs.length = 0;
});

const api = (route: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${port}/api/v1/settings${route}`, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  });
const post = (route: string, body?: unknown) =>
  api(route, { method: 'POST', body: JSON.stringify(body ?? {}) });

const at = () => ({ hostname: '127.0.0.1', port: silo.port(), useSsl: false });

describe('connecting Silo', () => {
  it('connects with a pasted key, reads its libraries and keeps sign-in off when asked', async () => {
    const res = await post('/media-servers/silo/connect', {
      ...at(),
      apiKey: 'sa_test',
      externalHostname: 'https://silo.example.test',
      signIn: false,
    });
    assert.equal(res.status, 200, await res.clone().text());
    const silo = getSettings().silo;
    assert.equal(silo.connected, true);
    assert.equal(silo.apiKey, 'sa_test');
    assert.equal(silo.name, 'Glasswing');
    assert.equal(silo.serverId, '3f2a9d5e-6b1c-4c7e-9a0d-2f4b8c1e7a35');
    assert.equal(silo.serverVersion, '1.0.0');
    assert.deepEqual(silo.optionalScopes, [
      'admin:users',
      'admin:catalog:paths',
    ]);
    // Sorted as Silo sorts them; books, podcasts and manga left out.
    assert.deepEqual(
      silo.libraries.map((l) => [l.id, l.type, l.enabled]),
      [
        ['2', 'show', false],
        ['1', 'movie', false],
        ['3', 'mixed', false],
      ]
    );
    assert.deepEqual(connectedServers(), ['plex', 'silo']);
    assert.equal(signInAllowed('silo'), false);
    assert.ok(scheduledJobs.some((job) => job.id === 'silo-full-scan'));
    assert.ok(
      scheduledJobs.some((job) => job.id === 'silo-recently-added-scan')
    );
    const listed = (await res.json()) as { kind: string; signIn: boolean }[];
    assert.equal(listed.find((s) => s.kind === 'silo')?.signIn, false);
    assert.ok(!JSON.stringify(listed).includes('sa_test'), 'no API key');
    // The public settings don't offer Silo sign-in while it is off.
    assert.equal(
      getSettings().fullPublicSettings.mediaServers.find(
        (s) => s.kind === 'silo'
      )?.signIn,
      false
    );
  });

  it('signs in as an administrator once to create its own key', async () => {
    silo.accounts = [
      { id: '1', username: 'owner', password: 'pw', role: 'admin' },
    ];
    const res = await post('/media-servers/silo/connect', {
      ...at(),
      username: 'owner',
      password: 'pw',
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.match(getSettings().silo.apiKey, /^sa_made_/);
    const created = silo.calls.find((c) => c.path === '/admin/api-keys');
    // Only the required scopes; the optional ones come with a pasted key.
    assert.deepEqual(created?.body, {
      label: 'Seerr AI',
      scopes: ['admin:monitor:read', 'libraries:read'],
    });
    assert.deepEqual(getSettings().silo.optionalScopes, []);
    assert.ok(silo.calls.some((c) => c.path === '/auth/logout'));
    assert.deepEqual(silo.openSessions(), []);
  });

  it('forgets every link to a different Silo connected at the same place', async () => {
    const users = getRepository(User);
    const linked = await users.save(
      new User({
        email: 'lantern@test.local',
        siloUserId: '2',
        siloUsername: 'lantern',
        siloProfileId: '7',
        avatar: '',
      })
    );
    await getRepository(Media).save(
      new Media({
        tmdbId: 9101,
        mediaType: 'movie' as never,
        siloMediaId: 'movie-old',
      })
    );
    await getRepository(SiloEpisode).save(
      new SiloEpisode({
        contentId: 'old-episode',
        seriesId: 'old-series',
        libraryIds: ['2'],
        season: 1,
        episode: 1,
      })
    );
    await getRepository(SiloPlay).save(
      new SiloPlay({
        sessionId: 'old-play',
        userId: '2',
        itemId: 'movie-old',
        kind: 'movie',
        endedAt: new Date(),
      })
    );
    // The same address, now answered by a rebuilt Silo.
    getSettings().silo = { ...siloDefaults(), serverId: 'an-older-silo' };
    // Asked first: nothing changes until the admin confirms.
    const asked = await post('/media-servers/silo/connect', {
      ...at(),
      apiKey: 'sa_test',
    });
    assert.equal(asked.status, 409);
    assert.match(
      ((await asked.json()) as { message: string }).message,
      /removes every link to a Silo account \(1\).*\(1 plays\).*1 titles/
    );
    assert.equal(
      (await users.findOneByOrFail({ id: linked.id })).siloUserId,
      '2'
    );
    assert.equal(getSettings().silo.serverId, 'an-older-silo');
    const res = await post('/media-servers/silo/connect', {
      ...at(),
      apiKey: 'sa_test',
      confirmReset: true,
    });
    assert.equal(res.status, 200, await res.clone().text());
    const listed = (await res.json()) as { kind: string; notice?: string }[];
    assert.equal(
      listed.find((s) => s.kind === 'silo')?.notice,
      SILO_LINKS_RESET
    );
    assert.equal(listed.find((s) => s.kind === 'plex')?.notice, undefined);
    const after = await users.findOneByOrFail({ id: linked.id });
    assert.equal(after.siloUserId, null);
    assert.equal(after.siloUsername, null);
    assert.equal(after.siloProfileId, null);
    const media = await getRepository(Media).findOneByOrFail({ tmdbId: 9101 });
    assert.equal(media.siloMediaId, null);
    assert.equal(await getRepository(SiloEpisode).count(), 0);
    assert.equal(await getRepository(SiloPlay).count(), 0);
    assert.equal(getSettings().silo.serverId, silo.serverId);
  });

  it('never leaves the owner unable to sign in, and relinks whoever signs in', async () => {
    const users = getRepository(User);
    // The owner signs in only with the old Silo.
    await users
      .createQueryBuilder()
      .update(User)
      .set({
        siloUserId: '9',
        siloUsername: 'old-owner',
        userType: UserType.SILO,
        plexId: null,
        jellyfinUserId: null,
        embyUserId: null,
        password: () => 'NULL',
      })
      .where('id = 1')
      .execute();
    const silent = await users.save(
      new User({
        email: 'silo-only@test.local',
        siloUserId: '4',
        siloUsername: 'garden',
        userType: UserType.SILO,
        avatar: '',
      })
    );
    getSettings().silo = { ...siloDefaults(), serverId: 'an-older-silo' };

    // With a pasted key nothing proves who the owner is on the new Silo.
    let res = await post('/media-servers/silo/connect', {
      ...at(),
      apiKey: 'sa_test',
      confirmReset: true,
    });
    assert.equal(res.status, 409);
    assert.match(
      ((await res.json()) as { message: string }).message,
      /leave you unable to sign in/
    );
    assert.equal((await users.findOneByOrFail({ id: 1 })).siloUserId, '9');

    // Signing in to the new Silo links the owner to that account.
    silo.accounts = [
      { id: '1', username: 'lantern', password: 'pw', role: 'admin' },
    ];
    res = await post('/media-servers/silo/connect', {
      ...at(),
      username: 'lantern',
      password: 'pw',
      confirmReset: true,
    });
    assert.equal(res.status, 200, await res.clone().text());
    const owner = await users.findOneByOrFail({ id: 1 });
    assert.equal(owner.siloUserId, '1');
    assert.equal(owner.siloUsername, 'lantern');
    assert.equal(
      (await users.findOneByOrFail({ id: silent.id })).siloUserId,
      null
    );
  });

  it('ends only sessions that came from Silo, keeping the admin’s own', async () => {
    const users = getRepository(User);
    const fromSilo = await users.save(
      new User({
        email: 'from-silo@test.local',
        siloUserId: '5',
        userType: UserType.SILO,
        avatar: '',
      })
    );
    const withPassword = await users.save(
      new User({
        email: 'password@test.local',
        siloUserId: '6',
        userType: UserType.LOCAL,
        avatar: '',
      })
    );
    const sessions = getRepository(Session);
    const open = (id: string, userId: number) =>
      sessions.save(
        Object.assign(new Session(), {
          id,
          expiredAt: Date.now() + 60_000,
          json: JSON.stringify({ userId }),
        })
      );
    await open('silo-1', fromSilo.id);
    await open('silo-2', fromSilo.id);
    await open('local-1', withPassword.id);

    await forgetPreviousSilo({ userId: fromSilo.id, sessionId: 'silo-2' });
    const left = (await sessions.find()).map((session) => session.id).sort();
    assert.deepEqual(left, ['local-1', 'silo-2']);
  });

  it('keeps links when the same Silo is connected again', async () => {
    const linked = await getRepository(User).save(
      new User({
        email: 'harbour@test.local',
        siloUserId: '3',
        siloUsername: 'harbour',
        avatar: '',
      })
    );
    getSettings().silo = { ...siloDefaults(), serverId: silo.serverId };
    const res = await post('/media-servers/silo/connect', {
      ...at(),
      apiKey: 'sa_test',
    });
    assert.equal(res.status, 200, await res.clone().text());
    const listed = (await res.json()) as { kind: string; notice?: string }[];
    assert.equal(listed.find((s) => s.kind === 'silo')?.notice, undefined);
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: linked.id })).siloUserId,
      '3'
    );
  });

  it('deletes the key it made before when signing in to connect again', async () => {
    silo.accounts = [
      { id: '1', username: 'owner', password: 'pw', role: 'admin' },
    ];
    const signIn = () =>
      post('/media-servers/silo/connect', {
        ...at(),
        username: 'owner',
        password: 'pw',
      });
    let res = await signIn();
    assert.equal(res.status, 200, await res.clone().text());
    const first = getSettings().silo.apiKey;
    assert.ok(getSettings().silo.keyId, 'the key it made is recorded');
    // Not shown with the settings.
    assert.equal(
      ((await (await api('/silo')).json()) as { keyId?: string }).keyId,
      undefined
    );

    // Removing Silo can't delete it (a key can't delete itself), so the
    // next sign-in does.
    res = await api('/media-servers/silo', { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.ok(silo.keys.has(first));
    res = await signIn();
    assert.equal(res.status, 200, await res.clone().text());
    assert.notEqual(getSettings().silo.apiKey, first);
    assert.equal(silo.keys.has(first), false, 'the old key is gone');
    assert.ok(silo.keys.has(getSettings().silo.apiKey));
  });

  it('deletes the key it made when that key then fails', async () => {
    silo.accounts = [
      { id: '1', username: 'owner', password: 'pw', role: 'admin' },
    ];
    silo.mintNonAdminKeys = true;
    const before = [...silo.keys.keys()];
    const res = await post('/media-servers/silo/connect', {
      ...at(),
      username: 'owner',
      password: 'pw',
    });
    assert.equal(res.status, 403);
    assert.ok(
      silo.calls.some(
        (c) => c.method === 'DELETE' && c.path.startsWith('/admin/api-keys/')
      )
    );
    assert.deepEqual([...silo.keys.keys()], before, 'no key left behind');
    assert.deepEqual(silo.openSessions(), []);
    assert.equal(getSettings().silo.connected, false);
  });

  it('says plainly why it could not connect', async () => {
    const message = async (body: Record<string, unknown>) => {
      const res = await post('/media-servers/silo/connect', {
        ...at(),
        ...body,
      });
      return [res.status, ((await res.json()) as { message: string }).message];
    };

    silo.keys.set('sa_narrow', { scopes: ['libraries:read'], admin: true });
    assert.deepEqual(await message({ apiKey: 'sa_narrow' }), [
      403,
      "This API key can't read what Seerr AI needs. It needs the admin:monitor:read scope, and must belong to a Silo administrator.",
    ]);
    assert.deepEqual(await message({ apiKey: 'sa_nobody' }), [
      401,
      "Silo didn't accept this API key.",
    ]);

    silo.accounts = [
      { id: '1', username: 'owner', password: 'pw', role: 'admin' },
      { id: '2', username: 'guest', password: 'pw', role: 'user' },
    ];
    assert.deepEqual(await message({ username: 'guest', password: 'pw' }), [
      403,
      'Sign in with a Silo administrator account.',
    ]);
    assert.deepEqual(await message({ username: 'owner', password: 'no' }), [
      401,
      "Silo didn't accept that username and password.",
    ]);
    silo.refuseKeyCreation = true;
    assert.deepEqual(await message({ username: 'owner', password: 'pw' }), [
      403,
      "Silo didn't let this sign-in create an API key. In Silo, create a key with the admin:monitor:read and libraries:read scopes and paste it here instead.",
    ]);

    silo.apiMajor = 3;
    assert.deepEqual(await message({ apiKey: 'sa_test' }), [
      400,
      'This Silo speaks API v3; Seerr AI supports v2.',
    ]);
    assert.equal(getSettings().silo.connected, false);
  });

  it('waits for setup with another server first', async () => {
    getSettings().main.mediaServerType = MediaServerType.NOT_CONFIGURED;
    getSettings().plex.connected = false;
    const res = await post('/media-servers/silo/connect', {
      ...at(),
      apiKey: 'sa_test',
    });
    assert.equal(res.status, 400);
    assert.equal(getSettings().silo.connected, false);
  });
});

describe('a connected Silo', () => {
  beforeEach(() => {
    getSettings().silo = silo.settings({
      libraries: [{ id: '1', name: 'Films', enabled: false, type: 'movie' }],
    });
  });

  it('can be made primary, and its sign-in turned on and off', async () => {
    let res = await post('/media-servers/silo/sign-in', { signIn: false });
    assert.equal(res.status, 200);
    assert.equal(signInAllowed('silo'), false);
    res = await post('/media-servers/silo/sign-in', { signIn: true });
    assert.equal(res.status, 200);
    assert.equal(signInAllowed('silo'), true);
    assert.equal(
      getSettings().fullPublicSettings.mediaServers.find(
        (s) => s.kind === 'silo'
      )?.signIn,
      true
    );
    res = await post('/media-servers/silo/primary');
    assert.equal(res.status, 200);
    assert.equal(getSettings().main.mediaServerType, MediaServerType.SILO);
    assert.deepEqual(connectedServers(), ['silo', 'plex']);
  });

  it('connects with sign-in on by default', async () => {
    getSettings().silo = siloDefaults();
    const res = await post('/media-servers/silo/connect', {
      ...at(),
      apiKey: 'sa_test',
    });
    assert.equal(res.status, 200);
    assert.equal(signInAllowed('silo'), true);
  });

  it('shows its settings without the key, and keeps the key on save', async () => {
    let res = await api('/silo');
    const shown = (await res.json()) as { apiKey: string; hasApiKey: boolean };
    assert.equal(shown.apiKey, '');
    assert.equal(shown.hasApiKey, true);

    res = await post('/silo', {
      ...at(),
      externalHostname: 'https://silo.example.test',
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(getSettings().silo.apiKey, 'sa_test');
    assert.equal(
      getSettings().silo.externalHostname,
      'https://silo.example.test'
    );

    // A new address needs the key again.
    res = await post('/silo', { ...at(), hostname: 'localhost' });
    assert.equal(res.status, 400);
  });

  it('reads its libraries again and turns one on', async () => {
    let res = await post('/silo/library/sync');
    assert.equal(res.status, 200);
    assert.deepEqual(
      getSettings().silo.libraries.map((l) => l.id),
      ['2', '1', '3']
    );
    res = await api('/silo/library/1', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 200);
    assert.equal(
      getSettings().silo.libraries.find((l) => l.id === '1')?.enabled,
      true
    );
    res = await post('/silo/library/sync');
    assert.equal(
      getSettings().silo.libraries.find((l) => l.id === '1')?.enabled,
      true,
      'kept on'
    );
  });

  it('is removed cleanly: key, title ids and its episode list go', async () => {
    await getRepository(Media).save(
      new Media({
        tmdbId: 9100,
        mediaType: 'movie' as never,
        siloMediaId: 'movie-tmdb-9100',
      })
    );
    await getRepository(SiloEpisode).save(
      new SiloEpisode({
        contentId: 'episode-1',
        seriesId: 'series-1',
        libraryIds: ['2'],
        season: 1,
        episode: 1,
      })
    );
    const res = await api('/media-servers/silo', { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(getSettings().silo.connected, false);
    assert.equal(getSettings().silo.apiKey, '');
    const media = await getRepository(Media).findOneByOrFail({ tmdbId: 9100 });
    assert.equal(media.siloMediaId, null);
    assert.equal(await getRepository(SiloEpisode).count(), 0);
  });

  it('becomes primary on removing Plex only if it offers sign-in', async () => {
    const res = await api('/media-servers/plex', { method: 'DELETE' });
    if (signInOffered('silo')) {
      assert.equal(res.status, 200);
      assert.equal(getSettings().main.mediaServerType, MediaServerType.SILO);
    } else {
      assert.equal(res.status, 400);
      assert.equal(getSettings().main.mediaServerType, MediaServerType.PLEX);
      assert.equal(getSettings().plex.connected, true);
    }
  });
});

describe('connecting a different Silo, safely', () => {
  /** Someone who signs in only with the old Silo, as account "2". */
  const oldAccountTwo = () =>
    getRepository(User).save(
      new User({
        email: 'garden@test.local',
        siloUserId: '2',
        siloUsername: 'garden',
        userType: UserType.SILO,
        avatar: '',
      })
    );

  beforeEach(() => {
    resetSiloIdentityForTests();
    // Account "2" on the new Silo is someone else.
    silo.accounts = [
      { id: '1', username: 'owner', password: 'pw', role: 'admin' },
      { id: '2', username: 'stranger', password: 'pw', role: 'user' },
    ];
    getSettings().silo = { ...siloDefaults(), serverId: 'an-older-silo' };
  });

  it('lets nobody sign in through the new Silo until the old links are gone', async (t) => {
    const garden = await oldAccountTwo();
    // Hold forgetting the old Silo, once the new connection is saved.
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached = () => undefined as void;
    const holding = new Promise<void>((resolve) => (reached = resolve));
    const episodes = getRepository(SiloEpisode);
    const clear = episodes.clear.bind(episodes);
    t.mock.method(episodes, 'clear', async () => {
      reached();
      await held;
      return clear();
    });
    const connecting = post('/media-servers/silo/connect', {
      ...at(),
      apiKey: 'sa_test',
      confirmReset: true,
    });
    await holding;
    assert.equal(getSettings().silo.serverId, silo.serverId);
    assert.ok(getSettings().silo.resetPending, 'marked in the same change');
    // The new Silo's account "2" must not sign in as Garden meanwhile.
    await assert.rejects(
      () => siloPasswordSignIn('stranger', 'pw'),
      (e: Error) =>
        e instanceof SiloSignInError &&
        e.reason === 'differentServer' &&
        e.status === 503
    );
    release();
    const res = await connecting;
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(getSettings().silo.resetPending, null);
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: garden.id })).siloUserId,
      null
    );
    // Now the new Silo is used, and account "2" is nobody's here.
    assert.equal((await siloPasswordSignIn('stranger', 'pw')).id, '2');
  });

  it('puts the old Silo back exactly when saving a different one fails', async (t) => {
    const garden = await oldAccountTwo();
    const settings = getSettings();
    for (const route of ['/media-servers/silo/connect', '/silo']) {
      settings.restore('silo', {
        ...siloDefaults(),
        name: 'Static Garden',
        serverId: 'an-older-silo',
        apiKey: 'sa_old',
      });
      const failing = t.mock.method(settings, 'save', async () => {
        throw new Error('The disk is full.');
      });
      const res = await post(route, {
        ...at(),
        apiKey: 'sa_test',
        confirmReset: true,
      });
      failing.mock.restore();
      assert.notEqual(res.status, 200, route);
      // No reset mark is left against the old Silo.
      assert.ok(!settings.silo.resetPending, route);
      assert.equal(settings.silo.serverId, 'an-older-silo', route);
      assert.equal(settings.silo.apiKey, 'sa_old', route);
      assert.equal(settings.silo.name, 'Static Garden', route);
      // So nothing forgets the old Silo's links.
      assert.equal(await finishSiloReset(), true);
      assert.equal(
        (await getRepository(User).findOneByOrFail({ id: garden.id }))
          .siloUserId,
        '2',
        route
      );
    }
  });

  it('keeps whom a pending reset links when Silo is saved again, and never locks the owner out', async (t) => {
    const users = getRepository(User);
    // The owner signs in only with the old Silo, as account "9" (Plex
    // sign-in is off).
    getSettings().plex.signIn = false;
    await users
      .createQueryBuilder()
      .update(User)
      .set({
        siloUserId: '9',
        siloUsername: 'lantern',
        userType: UserType.SILO,
        password: () => 'NULL',
      })
      .where('id = 1')
      .execute();
    const failing = t.mock.method(
      getRepository(SiloEpisode),
      'clear',
      async () => {
        throw new Error('The disk is full.');
      }
    );
    // Pending, naming the owner and the new Silo's account they signed in
    // as: saving the key again keeps both.
    getSettings().restore(
      'silo',
      silo.settings({
        resetPending: { userId: 1, accountId: '1', accountUsername: 'owner' },
      })
    );
    let res = await post('/silo', { ...at(), apiKey: 'sa_test' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(getSettings().silo.resetPending, {
      userId: 1,
      accountId: '1',
      accountUsername: 'owner',
    });

    // Pending for someone else, with no account for the owner: saving it
    // again would leave the owner unable to sign in, so it is refused.
    getSettings().restore(
      'silo',
      silo.settings({ resetPending: { userId: 2 } })
    );
    await users.update(1, { siloUserId: '9' });
    res = await post('/silo', { ...at(), apiKey: 'sa_test' });
    assert.equal(res.status, 409);
    assert.match(
      ((await res.json()) as { message: string }).message,
      /Set a password for your account first/
    );
    assert.deepEqual(getSettings().silo.resetPending, { userId: 2 });
    failing.mock.restore();
  });

  it('stays closed when forgetting the old Silo fails or stops part-way, and finishes later', async (t) => {
    const garden = await oldAccountTwo();
    const episodes = getRepository(SiloEpisode);
    const failing = t.mock.method(episodes, 'clear', async () => {
      throw new Error('The disk is full.');
    });
    const res = await post('/media-servers/silo/connect', {
      ...at(),
      apiKey: 'sa_test',
      confirmReset: true,
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(failing.mock.callCount(), 1);
    // Saved with the new connection, still marked.
    assert.equal(getSettings().silo.serverId, silo.serverId);
    assert.ok(getSettings().silo.resetPending);
    await assert.rejects(
      () => siloPasswordSignIn('stranger', 'pw'),
      (e: Error) => e instanceof SiloSignInError && e.status === 503
    );
    failing.mock.restore();

    // As at startup, or the next history job: the reset is finished.
    assert.equal(await finishSiloReset(), true);
    assert.equal(getSettings().silo.resetPending, null);
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: garden.id })).siloUserId,
      null
    );
    assert.equal((await siloPasswordSignIn('stranger', 'pw')).id, '2');
  });

  it('finishes a reset a restart cut short, keeping whoever connected it linked', async () => {
    const garden = await oldAccountTwo();
    // Saved before Seerr AI stopped: the new connection and the mark.
    getSettings().silo = silo.settings({
      resetPending: {
        userId: 1,
        accountId: '1',
        accountUsername: 'owner',
      },
    });
    await assert.rejects(() => siloPasswordSignIn('owner', 'pw'));
    assert.equal(await finishSiloReset(), true);
    const users = getRepository(User);
    assert.equal(
      (await users.findOneByOrFail({ id: garden.id })).siloUserId,
      null
    );
    const owner = await users.findOneByOrFail({ id: 1 });
    assert.equal(owner.siloUserId, '1');
    assert.equal(owner.siloUsername, 'owner');
    assert.equal(getSettings().silo.resetPending, null);
  });

  it('stops a scan under way, and drops Match Check findings, before clearing', async (t) => {
    const dropped = t.mock.method(plexMatchCheck, 'dropServer', async () => {
      return undefined;
    });
    const watchDropped = t.mock.method(matchWatch, 'dropServer', async () => {
      return undefined;
    });
    getSettings().silo = silo.settings({
      libraries: [
        { id: '1', name: 'Films', type: 'movie', enabled: true },
      ] as never,
    });
    silo.items = [siloMovie('movie-glasswing', { tmdbId: 9102 })];
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached = () => undefined as void;
    const holding = new Promise<void>((resolve) => (reached = resolve));
    silo.beforeAnswer = async (_method, path) => {
      if (path !== '/api/v2/admin/catalog/items') return;
      silo.beforeAnswer = undefined;
      reached();
      await held;
    };
    const scan = siloFullScanner.run();
    await holding;
    let forgotten = false;
    const forgetting = forgetPreviousSilo().then(() => (forgotten = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(forgotten, false, 'waits for the scan to stop');
    release();
    await forgetting;
    await scan;
    assert.equal(siloFullScanner.status().running, false);
    assert.equal(
      await getRepository(Media).countBy({ siloMediaId: Not(IsNull()) }),
      0
    );
    assert.deepEqual(
      dropped.mock.calls.map((call) => call.arguments[0]),
      ['Silo']
    );
    assert.deepEqual(
      watchDropped.mock.calls.map((call) => call.arguments[0]),
      ['Silo']
    );
  });

  it('treats Silo as different when none is on record but people are linked', async () => {
    // Settings lost, the database kept.
    const garden = await oldAccountTwo();
    getSettings().restore('silo', siloDefaults());
    let res = await post('/media-servers/silo/connect', {
      ...at(),
      apiKey: 'sa_test',
    });
    assert.equal(res.status, 409);
    assert.match(
      ((await res.json()) as { message: string }).message,
      /no record of which Silo/
    );
    assert.equal(getSettings().silo.serverId, '');
    res = await post('/media-servers/silo/connect', {
      ...at(),
      apiKey: 'sa_test',
      confirmReset: true,
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.ok(!getSettings().silo.resetPending);
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: garden.id })).siloUserId,
      null
    );
  });

  it('marks for linking again by name only those who may be, for 30 days', async () => {
    const users = getRepository(User);
    const garden = await oldAccountTwo();
    await users.update(garden.id, { permissions: 0 });
    // Manages requests: more than new users get.
    const glasswing = await users.save(
      new User({
        email: 'glasswing@test.local',
        siloUserId: '3',
        siloUsername: 'glasswing',
        userType: UserType.SILO,
        permissions: Permission.MANAGE_REQUESTS,
        avatar: '',
      })
    );
    await forgetPreviousSilo();
    const until = (await users.findOneByOrFail({ id: garden.id }))
      .siloRelinkUntil;
    assert.ok(until);
    const days = (new Date(until).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30, String(days));
    assert.equal(
      (await users.findOneByOrFail({ id: glasswing.id })).siloRelinkUntil,
      null
    );
  });

  it('a scan writes nothing it read before a reset was marked, and one that won’t stop holds the reset back', async () => {
    getSettings().restore(
      'silo',
      silo.settings({
        libraries: [
          { id: '1', name: 'Films', type: 'movie', enabled: true },
        ] as never,
      })
    );
    silo.items = [siloMovie('movie-glasswing', { tmdbId: 9102 })];
    const holdCatalog = () => {
      let release = () => undefined as void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let reached = () => undefined as void;
      const holding = new Promise<void>((resolve) => (reached = resolve));
      silo.beforeAnswer = async (_method, path) => {
        if (path !== '/api/v2/admin/catalog/items') return;
        silo.beforeAnswer = undefined;
        reached();
        await held;
      };
      return { holding, release };
    };

    // Marked while the scan reads Silo: nothing it read is written.
    let hold = holdCatalog();
    let scan = siloFullScanner.run();
    await hold.holding;
    noteSiloResetMarked();
    hold.release();
    await scan;
    assert.equal(
      await getRepository(Media).countBy({ siloMediaId: Not(IsNull()) }),
      0
    );

    // A scan that doesn't stop in time: the reset waits, to be tried again.
    hold = holdCatalog();
    scan = siloFullScanner.run();
    await hold.holding;
    await assert.rejects(() => siloFullScanner.stop(20), /did not stop/);
    hold.release();
    await scan;
  });

  it('says who would be left without a way to sign in', async () => {
    const users = getRepository(User);
    await oldAccountTwo();
    // An administrator from Silo with no password: never linked again by
    // name.
    await users.save(
      new User({
        email: 'lantern@test.local',
        siloUserId: '3',
        siloUsername: 'lantern',
        userType: UserType.SILO,
        permissions: Permission.ADMIN,
        avatar: '',
      })
    );
    // Has a password: not counted.
    const harbour = new User({
      email: 'harbour@test.local',
      siloUserId: '5',
      siloUsername: 'harbour',
      userType: UserType.SILO,
      avatar: '',
    });
    await harbour.setPassword('Harbour Lights 1');
    await users.save(harbour);
    const res = await post('/media-servers/silo/connect', {
      ...at(),
      apiKey: 'sa_test',
    });
    assert.equal(res.status, 409);
    const { message } = (await res.json()) as { message: string };
    assert.match(message, /\(3\)/);
    assert.match(
      message,
      /1 of them sign in only with Silo and are linked again if they sign in with the new Silo under the same username within 30 days/
    );
    assert.match(message, /1 of them would be left unable to sign in/);
  });

  it('refuses when the owner’s only other server can’t sign them in, and says how to fix it', async () => {
    const users = getRepository(User);
    // Linked to Plex, but Plex sign-in is off.
    await users
      .createQueryBuilder()
      .update(User)
      .set({
        siloUserId: '9',
        siloUsername: 'old-owner',
        userType: UserType.SILO,
        plexId: 4242,
        password: () => 'NULL',
      })
      .where('id = 1')
      .execute();
    getSettings().plex.signIn = false;
    let res = await post('/media-servers/silo/connect', {
      ...at(),
      apiKey: 'sa_test',
      confirmReset: true,
    });
    assert.equal(res.status, 409);
    assert.match(
      ((await res.json()) as { message: string }).message,
      /Set a password for your account first/
    );
    // With Plex sign-in on, Plex still signs them in.
    getSettings().plex.signIn = true;
    res = await post('/media-servers/silo/connect', {
      ...at(),
      apiKey: 'sa_test',
      confirmReset: true,
    });
    assert.equal(res.status, 200, await res.clone().text());
  });
});
