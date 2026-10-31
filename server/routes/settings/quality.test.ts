import { QualityArr } from '@server/lib/quality/arr';
import * as trashModule from '@server/lib/quality/trash';
import { serverDefaults } from '@server/lib/quality/types';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';

/*
 * Settings → Quality's choices as saved: only what is valid, one entry a
 * server. Nothing reaches a server here.
 */

setupTestDb();

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

const server = (managed: boolean) => ({
  ...serverDefaults('radarr', 0, false),
  managed,
});

beforeEach(() => {
  const settings = getSettings();
  settings.radarr = [
    {
      id: 0,
      name: 'Radarr',
      hostname: 'radarr',
      activeProfileId: 1,
      is4k: false,
    } as unknown as RadarrSettings,
  ];
  settings.sonarr = [];
  settings.quality = {
    trash: { autoApply: false, fillGaps: true },
    servers: [server(true)],
  };
  mock.method(settings, 'save', async () => undefined);
  // No server is reached: each answers as one that can't be.
  mock.method(QualityArr, 'forServer', () => undefined);
  mock.method(trashModule, 'readTrashState', async () => ({ blobs: {} }));
});

afterEach(() => {
  mock.restoreAll();
});

describe('saving the quality choices', () => {
  it('refuses the same server twice, and keeps what was saved', async () => {
    const res = await request(app)
      .put('/api/v1/settings/quality')
      .send({
        trash: { autoApply: true, fillGaps: true },
        servers: [server(true), server(false)],
      });
    assert.equal(res.status, 400);
    assert.equal(getSettings().quality.trash.autoApply, false);
    assert.equal(getSettings().quality.servers[0].managed, true);
  });
});
