import SiloAPI, { SiloError } from '@server/api/silo/client';
import {
  SiloIncompatibleError,
  contractChanged,
} from '@server/api/silo/compat';
import { createFakeSilo, siloMovie } from '@server/test/fakeSilo';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

const silo = createFakeSilo();
const host = () => `http://127.0.0.1:${silo.port()}`;
const client = (key = 'sa_test') => new SiloAPI(host(), key);

before(() => silo.start());
after(() => silo.stop());
beforeEach(() => silo.reset());

describe('the Silo client', () => {
  it('reads every page of a listing, 200 at a time', async () => {
    silo.items = Array.from({ length: 450 }, (_, i) =>
      siloMovie(`movie-${i}`, { tmdbId: 1000 + i })
    );
    const items = await client().listCatalogItems({ type: 'movie' });
    assert.equal(items.length, 450);
    assert.equal(new Set(items.map((item) => item.content_id)).size, 450);
    const pages = silo.calls.filter((c) => c.path === '/admin/catalog/items');
    assert.equal(pages.length, 3);
    assert.ok(pages.every((c) => c.query.limit === '200'));
    assert.equal(pages[0].query.cursor, undefined);
    assert.ok(pages[1].query.cursor);
  });

  it('asks for content ids in batches Silo accepts', async () => {
    silo.items = Array.from({ length: 250 }, (_, i) =>
      siloMovie(`movie-${i}`, { tmdbId: 1000 + i })
    );
    const ids = [...silo.items.map((item) => item.content_id), 'movie-gone'];
    const found = await client().getCatalogItems(ids);
    assert.equal(found.length, 250);
    const batches = silo.calls.filter((c) => c.path === '/admin/catalog/items');
    assert.equal(batches.length, 3);
    // One content_ids parameter per id, as Silo reads them.
    assert.ok(batches.every((c) => c.queryAll.content_ids.length <= 100));
    assert.equal(
      batches.flatMap((c) => c.queryAll.content_ids).length,
      ids.length
    );
    assert.ok(
      batches.every((c) => c.queryAll.content_ids.every((id) => !/,/.test(id)))
    );
  });

  it('never reads a broken page as an empty list', async () => {
    const broken = new SiloAPI(host(), 'sa_test');
    // A proxy's HTML page instead of Silo's answer.
    (broken as unknown as { patient: () => Promise<unknown> }).patient =
      async () => '<html>Sign in to the proxy</html>';
    await assert.rejects(
      () => broken.getCatalogItems(['movie-1']),
      (e: SiloError) => e.status === 502
    );
    (broken as unknown as { patient: () => Promise<unknown> }).patient =
      async () => ({ items: [], page: { has_more: true } });
    await assert.rejects(
      () => broken.listCatalogItems(),
      (e: SiloError) => e.status === 502
    );
    // Unpaged collections too.
    (broken as unknown as { patient: () => Promise<unknown> }).patient =
      async () => '<html>Sign in to the proxy</html>';
    await assert.rejects(
      () => broken.getUserLibraries(),
      (e: SiloError) => e.status === 502
    );
    await assert.rejects(
      () => broken.getAccountProfiles('1'),
      (e: SiloError) => e.status === 502
    );
    (broken as unknown as { call: () => Promise<unknown> }).call =
      async () => ({
        profiles: [],
      });
    await assert.rejects(
      () => broken.getAccountProfiles('1', { wait: false }),
      (e: SiloError) => e.status === 502
    );
  });

  it('stops at an API major it does not know', async () => {
    silo.apiMajor = 3;
    await assert.rejects(
      () => client().getCompatibleInfo(),
      (e: Error) =>
        e instanceof SiloIncompatibleError &&
        e.message === 'This Silo speaks API v3; Seerr AI supports v2.'
    );
    silo.apiMajor = 2;
    assert.equal((await client().getCompatibleInfo()).api_major, 2);
  });

  it('notices only a real change of contract', () => {
    assert.equal(contractChanged('', { contract_digest: 'b' }), false);
    assert.equal(contractChanged('a', { contract_digest: 'a' }), false);
    assert.equal(contractChanged('a', { contract_digest: 'b' }), true);
  });

  it('finds which scopes a key holds', async () => {
    assert.deepEqual(await client().probeScopes(), {
      missing: [],
      optional: ['admin:users', 'admin:catalog:paths'],
    });

    silo.keys.set('sa_minimal', {
      scopes: ['admin:monitor:read', 'libraries:read'],
      admin: true,
    });
    assert.deepEqual(await client('sa_minimal').probeScopes(), {
      missing: [],
      optional: [],
    });

    silo.keys.set('sa_libraries', { scopes: ['libraries:read'], admin: true });
    assert.deepEqual(await client('sa_libraries').probeScopes(), {
      missing: ['admin:monitor:read'],
      optional: [],
    });

    // Scopes never get past Silo's roles.
    silo.keys.set('sa_user', {
      scopes: ['admin:monitor:read', 'libraries:read'],
      admin: false,
    });
    assert.deepEqual((await client('sa_user').probeScopes()).missing, [
      'admin:monitor:read',
    ]);
  });

  it('waits out a rate limit, then reads on', async () => {
    silo.items = [siloMovie('movie-1', { tmdbId: 1 })];
    silo.rateLimited = 1;
    const items = await client().listCatalogItems();
    assert.equal(items.length, 1);
  });

  it('turns failures into plain errors', async () => {
    await assert.rejects(
      () => client('sa_wrong').getServerStatus(),
      (e: Error) =>
        e instanceof SiloError &&
        e.status === 401 &&
        e.code === 'authentication_required' &&
        e.message === "Silo didn't accept these credentials."
    );
    const nowhere = new SiloAPI('http://127.0.0.1:1', 'sa_test', {
      timeout: 2000,
    });
    await assert.rejects(
      () => nowhere.getSystemInfo(),
      (e: Error) =>
        e instanceof SiloError &&
        e.status === 0 &&
        e.message === "Seerr AI couldn't reach Silo at that address."
    );
  });

  it('signs in, creates a key, and signs out', async () => {
    silo.accounts = [
      { id: '1', username: 'owner', password: 'pw', role: 'admin' },
    ];
    const open = new SiloAPI(host());
    const tokens = await open.login('owner', 'pw', 'seerr-ai-test');
    assert.equal(tokens.user.role, 'admin');
    const created = await open.createApiKey(tokens.access_token, {
      label: 'Seerr AI',
      scopes: ['admin:monitor:read', 'libraries:read'],
    });
    assert.match(created.key, /^sa_made_/);
    await open.logout(tokens.access_token);
    const login = silo.calls.find((c) => c.path === '/auth/login');
    assert.deepEqual(login?.body, { username: 'owner', password: 'pw' });
    assert.ok(silo.calls.some((c) => c.path === '/auth/logout'));
  });
});

describe('the Silo client, for people', () => {
  beforeEach(() => {
    silo.accounts = [
      {
        id: 'acct-1',
        username: 'harbour',
        password: 'lights',
        role: 'admin',
        email: 'harbour@example.invalid',
        profiles: [
          { id: 'p-1', name: 'Harbour', is_primary: true },
          { id: 'p-2', name: 'Lantern', is_primary: false, is_child: true },
        ],
      },
      { id: 'acct-2', username: 'garden', password: 'x', role: 'user' },
    ];
  });

  it('signs in with the stable device id, and signs out', async () => {
    const open = new SiloAPI(host());
    const tokens = await open.login('harbour', 'lights', 'seerr-ai-test');
    assert.equal(tokens.user.id, 'acct-1');
    const call = silo.calls.find((c) => c.path === '/auth/login');
    assert.deepEqual(call?.body, { username: 'harbour', password: 'lights' });
    assert.equal(silo.openSessions().length, 1);
    await open.logout(tokens.access_token);
    assert.equal(silo.openSessions().length, 0);
  });

  it('reports a locked name as a rate limit', async () => {
    silo.lockedNames.add('harbour');
    await assert.rejects(
      () => new SiloAPI(host()).login('harbour', 'lights', 'seerr-ai-test'),
      (e: SiloError) => e.status === 429 && e.retryAfter === 60
    );
  });

  it('runs a device sign-in to its single answer', async () => {
    const open = new SiloAPI(host());
    const start = await open.startDeviceLogin();
    assert.match(start.user_code, /^\d{4}-\d{4}$/);
    assert.equal(
      (await open.pollDeviceLogin(start.device_code, 'seerr-ai-test')).status,
      'pending'
    );
    silo.approveDevice(start.user_code, 'acct-1', 'p-2');
    const approved = await open.pollDeviceLogin(
      start.device_code,
      'seerr-ai-test'
    );
    assert.equal(approved.status, 'approved');
    // Silo names a profile only for a temporary session.
    assert.equal(approved.profile_id, '');
    assert.equal(approved.tokens?.user.username, 'harbour');
    assert.equal(
      (await open.pollDeviceLogin(start.device_code, 'seerr-ai-test')).status,
      'consumed'
    );
  });

  it('reads accounts and profiles with the key', async () => {
    const users = await client().listAdminUsers();
    assert.deepEqual(
      users.map((user) => [user.id, user.enabled]),
      [
        ['acct-1', true],
        ['acct-2', true],
      ]
    );
    assert.equal((await client().getAdminUser('acct-2')).role, 'user');
    await assert.rejects(
      () => client().getAdminUser('acct-gone'),
      (e: SiloError) => e.status === 404
    );
    const profiles = await client().getAccountProfiles('acct-1');
    assert.deepEqual(
      profiles.map((profile) => profile.id),
      ['p-1', 'p-2']
    );
  });

  it('places pictures on Silo, under its URL base, or elsewhere', () => {
    const atBase = new SiloAPI('http://127.0.0.1:8090/silo', 'sa_test');
    assert.deepEqual(atBase.pictureAddress('/profile-avatars/fox.svg'), {
      url: 'http://127.0.0.1:8090/silo/profile-avatars/fox.svg',
      onSilo: true,
    });
    assert.deepEqual(
      atBase.pictureAddress('https://storage.example.invalid/a.png?sig=1'),
      { url: 'https://storage.example.invalid/a.png?sig=1', onSilo: false }
    );
    assert.equal(atBase.pictureAddress('javascript:alert(1)'), undefined);
  });
});
