import { SEASON_DEFAULTS } from '@server/lib/seasons';
import { getSettings } from '@server/lib/settings';
import settingsRoutes from '@server/routes/settings';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import request from 'supertest';

/*
 * The seasons a server runs (Settings → Appearance → Seasonal themes), and
 * what pages are told about them.
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
  delete getSettings().appearance.seasons;
});

describe('the seasons a server runs', () => {
  it('are Halloween, Holidays and New Year on a new server', async () => {
    const res = await request(app).get('/api/v1/settings/appearance/seasons');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { seasons: SEASON_DEFAULTS });
    assert.deepEqual(getSettings().fullPublicSettings.seasons, [
      { id: 'halloween', start: '10-24', end: '11-01' },
      { id: 'holidays', start: '12-01', end: '12-28' },
      { id: 'newyear', start: '12-29', end: '01-02' },
    ]);
  });

  it('change when an admin saves them, and pages are told', async () => {
    const res = await request(app)
      .post('/api/v1/settings/appearance/seasons')
      .send({
        seasons: {
          halloween: { enabled: false, start: '10-24', end: '11-01' },
          diwali: { enabled: true },
          pride: { enabled: true, start: '06-01', end: '06-30' },
        },
      });
    assert.equal(res.status, 200);
    const saved = {
      ...SEASON_DEFAULTS,
      halloween: { enabled: false, start: '10-24', end: '11-01' },
      diwali: { enabled: true },
      pride: { enabled: true, start: '06-01', end: '06-30' },
    };
    assert.deepEqual(res.body, { seasons: saved });
    assert.deepEqual(getSettings().appearance.seasons, saved);
    assert.deepEqual(getSettings().fullPublicSettings.seasons, [
      { id: 'holidays', start: '12-01', end: '12-28' },
      { id: 'newyear', start: '12-29', end: '01-02' },
      { id: 'diwali' },
      { id: 'pride', start: '06-01', end: '06-30' },
    ]);
  });

  it('keep the seasons a save leaves out as they were', async () => {
    getSettings().appearance.seasons = {
      ...SEASON_DEFAULTS,
      pride: { enabled: true, start: '06-01', end: '06-30' },
    };
    const res = await request(app)
      .post('/api/v1/settings/appearance/seasons')
      .send({ seasons: { holidays: { enabled: false } } });
    // Holidays' dates don't move, so it needs them.
    assert.equal(res.status, 400);
    const ok = await request(app)
      .post('/api/v1/settings/appearance/seasons')
      .send({
        seasons: { holidays: { enabled: false, start: '12-01', end: '12-28' } },
      });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.seasons.pride.enabled, true);
    assert.equal(ok.body.seasons.holidays.enabled, false);
  });

  it('refuses what is not a season, and keeps what was there', async () => {
    for (const body of [
      {},
      { seasons: null },
      { seasons: { easter: { enabled: true } } },
      {
        seasons: {
          halloween: { enabled: true, start: '10-24', end: '11-31' },
        },
      },
      { seasons: {}, extra: true },
    ]) {
      const res = await request(app)
        .post('/api/v1/settings/appearance/seasons')
        .send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(getSettings().appearance.seasons, undefined);
  });

  it('fall back to the defaults if settings.json was edited into nonsense', () => {
    (getSettings().appearance as { seasons: unknown }).seasons = {
      halloween: 'always',
      pride: { enabled: true, start: '06-01', end: '06-30' },
    };
    assert.deepEqual(getSettings().fullPublicSettings.seasons, [
      { id: 'halloween', start: '10-24', end: '11-01' },
      { id: 'holidays', start: '12-01', end: '12-28' },
      { id: 'newyear', start: '12-29', end: '01-02' },
      { id: 'pride', start: '06-01', end: '06-30' },
    ]);
  });
});
