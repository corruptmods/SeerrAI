import { getSettings } from '@server/lib/settings';
import migrateAnimeExcludedCountries from '@server/lib/settings/migrations/0011_anime_excluded_countries';
import settingsRoutes from '@server/routes/settings';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import request from 'supertest';

/*
 * "Leave out anime made in" (Settings → Services → Anime): the countries
 * whose anime does not count as anime unless it is in Japanese.
 */

const app = express();
app.use(express.json());
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
  ) => {
    res.status(err.status ?? 500).json({ message: err.message });
  }
);

beforeEach(() => {
  getSettings().main.animeExcludedCountries = [];
});

describe('the anime settings', () => {
  it('start empty on a new server, and say so in the public settings', async () => {
    const res = await request(app).get('/api/v1/settings/anime');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { excludedCountries: [] });
    assert.deepEqual(
      getSettings().fullPublicSettings.animeExcludedCountries,
      []
    );
  });

  it('replace the whole list, tidied', async () => {
    getSettings().main.animeExcludedCountries = ['US', 'KR'];
    const res = await request(app)
      .post('/api/v1/settings/anime')
      .send({ excludedCountries: ['cn', 'US', 'CN'] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { excludedCountries: ['CN', 'US'] });
    assert.deepEqual(getSettings().main.animeExcludedCountries, ['CN', 'US']);
    assert.deepEqual(getSettings().fullPublicSettings.animeExcludedCountries, [
      'CN',
      'US',
    ]);

    const emptied = await request(app)
      .post('/api/v1/settings/anime')
      .send({ excludedCountries: [] });
    assert.deepEqual(emptied.body, { excludedCountries: [] });
    assert.deepEqual(getSettings().main.animeExcludedCountries, []);
  });

  it('refuse anything that is not a list of country codes', async () => {
    getSettings().main.animeExcludedCountries = ['US'];
    for (const body of [
      {},
      { excludedCountries: 'US' },
      { excludedCountries: ['USA'] },
      { excludedCountries: ['U1'] },
    ]) {
      const res = await request(app).post('/api/v1/settings/anime').send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(getSettings().main.animeExcludedCountries, ['US']);
  });
});

describe('the upgrade to the setting', () => {
  it('keeps the old rule on a server from before it: American anime is left out', () => {
    const migrated = migrateAnimeExcludedCountries({
      main: { applicationTitle: 'Seerr AI' },
      migrations: ['0009_maintainerr_servers'],
    });
    assert.deepEqual(migrated.main.animeExcludedCountries, ['US']);
    assert.deepEqual(migrated.migrations, [
      '0009_maintainerr_servers',
      '0011_anime_excluded_countries',
    ]);
  });

  it('leaves a new server, which already has the setting, as it is', () => {
    const migrated = migrateAnimeExcludedCountries({
      main: { animeExcludedCountries: [] },
    });
    assert.deepEqual(migrated.main.animeExcludedCountries, []);
  });

  it('runs once: an admin who empties the list keeps it empty', () => {
    const once = migrateAnimeExcludedCountries({ main: {} });
    once.main.animeExcludedCountries = [];
    delete (once.main as { animeExcludedCountries?: string[] })
      .animeExcludedCountries;
    const twice = migrateAnimeExcludedCountries(once);
    assert.equal(twice.main.animeExcludedCountries, undefined);
  });
});
