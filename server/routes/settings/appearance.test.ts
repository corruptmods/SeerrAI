import { SERVER_THEME_DEFAULTS } from '@server/constants/theme';
import { getSettings } from '@server/lib/settings';
import settingsRoutes from '@server/routes/settings';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import request from 'supertest';

/*
 * The server's default look (Settings → Appearance): what everyone sees
 * who hasn't chosen their own, and the sign-in page.
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
  getSettings().appearance.default = { ...SERVER_THEME_DEFAULTS };
});

describe('the server’s default look', () => {
  it('is dark Classic with Indigo on a new server, and public', async () => {
    const res = await request(app).get('/api/v1/settings/appearance');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      default: { mode: 'dark', accent: 'indigo', background: 'classic' },
    });
    assert.deepEqual(getSettings().fullPublicSettings.themeDefault, {
      mode: 'dark',
      accent: 'indigo',
      background: 'classic',
    });
  });

  it('is replaced by what an admin saves, tidied', async () => {
    const res = await request(app)
      .post('/api/v1/settings/appearance')
      .send({
        default: {
          mode: 'auto',
          accent: 'custom',
          customAccent: '#E5A00D',
          background: 'warm',
        },
      });
    assert.equal(res.status, 200);
    const saved = {
      mode: 'auto',
      accent: 'custom',
      customAccent: '#e5a00d',
      background: 'warm',
    };
    assert.deepEqual(res.body, { default: saved });
    assert.deepEqual(getSettings().appearance.default, saved);
    assert.deepEqual(getSettings().fullPublicSettings.themeDefault, saved);
  });

  it('refuses anything that is not a look, and keeps the old one', async () => {
    for (const body of [
      {},
      { default: null },
      { default: { mode: 'dim', accent: 'indigo', background: 'classic' } },
      { default: { mode: 'dark', accent: 'custom', background: 'classic' } },
      {
        default: { mode: 'dark', accent: 'indigo', background: 'classic' },
        extra: true,
      },
    ]) {
      const res = await request(app)
        .post('/api/v1/settings/appearance')
        .send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(getSettings().appearance.default, SERVER_THEME_DEFAULTS);
  });

  it('falls back to Classic if settings.json was edited into nonsense', () => {
    (getSettings().appearance as { default: unknown }).default = {
      mode: 'neon',
    };
    assert.deepEqual(
      getSettings().fullPublicSettings.themeDefault,
      SERVER_THEME_DEFAULTS
    );
  });
});
