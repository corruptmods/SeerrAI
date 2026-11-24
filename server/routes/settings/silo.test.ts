import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import SiloEpisode from '@server/entity/SiloEpisode';
import { User } from '@server/entity/User';
import { scheduledJobs } from '@server/job/schedule';
import availabilitySync from '@server/lib/availabilitySync';
import { connectedServers, signInAllowed } from '@server/lib/mediaServers';
import { getSettings, siloDefaults } from '@server/lib/settings';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import { createFakeSilo } from '@server/test/fakeSilo';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import schedule from 'node-schedule';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

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
  it('connects with a pasted key, reads its libraries and keeps sign-in off', async () => {
    const res = await post('/media-servers/silo/connect', {
      ...at(),
      apiKey: 'sa_test',
      externalHostname: 'https://silo.example.test',
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
    // The public settings don't offer Silo sign-in.
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
    assert.deepEqual(created?.body, {
      label: 'Seerr AI',
      scopes: [
        'admin:monitor:read',
        'libraries:read',
        'admin:users',
        'admin:catalog:paths',
      ],
    });
    assert.ok(silo.calls.some((c) => c.path === '/auth/logout'));
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

  it("can't be primary or used for sign-in yet", async () => {
    let res = await post('/media-servers/silo/primary');
    assert.equal(res.status, 400);
    assert.equal(getSettings().main.mediaServerType, MediaServerType.PLEX);
    res = await post('/media-servers/silo/sign-in', { signIn: true });
    assert.equal(res.status, 400);
    assert.equal(signInAllowed('silo'), false);
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
});
