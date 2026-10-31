import { getRepository } from '@server/datasource';
import QualityApply from '@server/entity/QualityApply';
import { QualityArr } from '@server/lib/quality/arr';
import * as engine from '@server/lib/quality/engine';
import * as trashModule from '@server/lib/quality/trash';
import { serverDefaults } from '@server/lib/quality/types';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import settingsRoutes from '@server/routes/settings';
import { setJobWaitForTests } from '@server/routes/settings/quality';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';

/*
 * Settings → Quality's choices as saved: only what is valid, one entry a
 * server, and what an apply recorded kept. Nothing reaches a server here.
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
    servers: [
      { ...server(true), trashCommit: 'abc1234', appliedChoices: 'applied' },
    ],
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

  it('keeps what the last apply recorded', async () => {
    const res = await request(app)
      .put('/api/v1/settings/quality')
      .send({
        trash: { autoApply: false, fillGaps: true },
        servers: [{ ...server(true), trashCommit: 'x', appliedChoices: 'x' }],
      });
    assert.equal(res.status, 200);
    const [saved] = getSettings().quality.servers;
    assert.equal(saved.trashCommit, 'abc1234');
    assert.equal(saved.appliedChoices, 'applied');
  });

  it('offers Undo only on a server Seerr AI manages', async () => {
    await getRepository(QualityApply).save(
      new QualityApply({
        serverKind: 'radarr',
        serverId: 0,
        userId: null,
        summary: { created: 1, updated: 0 },
        befores: [],
        moved: [],
        undoneAt: null,
      })
    );
    const managed = await request(app).get('/api/v1/settings/quality');
    assert.equal(managed.body.history[0].canUndo, true);
    const res = await request(app)
      .put('/api/v1/settings/quality')
      .send({
        trash: { autoApply: false, fillGaps: true },
        servers: [server(false)],
      });
    assert.equal(res.body.history[0].canUndo, false);
  });
});

describe('a slow apply', () => {
  afterEach(() => setJobWaitForTests(4000));

  it('answers with a job, which then says how it went', async () => {
    setJobWaitForTests(20);
    let finish = () => undefined as void;
    mock.method(
      engine,
      'apply',
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ applyId: 7, created: 3, updated: 1, moved: 0 });
        })
    );
    mock.method(engine, 'stateOf', async () => ({}));
    const started = await request(app)
      .post('/api/v1/settings/quality/servers/radarr/0/apply')
      .send({ token: 'abc' });
    assert.equal(started.status, 202);
    const job = started.body.job as string;
    assert.ok(job);

    const going = await request(app).get(
      `/api/v1/settings/quality/jobs/${job}`
    );
    assert.equal(going.status, 200);
    assert.equal(going.body.done, false);

    finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const done = await request(app).get(`/api/v1/settings/quality/jobs/${job}`);
    assert.deepEqual(done.body, {
      done: true,
      status: 200,
      body: { applyId: 7, created: 3, updated: 1, moved: 0 },
    });
    const unknown = await request(app).get(
      '/api/v1/settings/quality/jobs/no-such-job'
    );
    assert.equal(unknown.status, 404);
  });

  it('answers at once when it is quick, as before', async () => {
    mock.method(engine, 'apply', async () => ({
      applyId: 8,
      created: 0,
      updated: 1,
      moved: 0,
    }));
    mock.method(engine, 'stateOf', async () => ({}));
    const res = await request(app)
      .post('/api/v1/settings/quality/servers/radarr/0/apply')
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.applyId, 8);
  });
});

describe('where new requests go, as saved', () => {
  it('takes a preset or keep, and refuses anime for the main one', async () => {
    const save = (requestPreset: string) =>
      request(app)
        .put('/api/v1/settings/quality')
        .send({
          trash: { autoApply: false, fillGaps: true },
          servers: [
            {
              ...server(true),
              requestPreset,
              animeRequestPreset: 'keep',
            },
          ],
        });
    assert.equal((await save('2160p')).status, 200);
    const saved = getSettings().quality.servers[0];
    assert.equal(saved.requestPreset, '2160p');
    assert.equal(saved.animeRequestPreset, 'keep');
    assert.equal((await save('keep')).status, 200);
    assert.equal((await save('anime')).status, 400);
  });
});
