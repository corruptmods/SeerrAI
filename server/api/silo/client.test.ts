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
    assert.equal(batches.length, 2);
    assert.ok(
      batches.every((c) => c.query.content_ids.split(',').length <= 200)
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
