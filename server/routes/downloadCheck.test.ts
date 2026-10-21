import { getRepository } from '@server/datasource';
import type { CheckStatus } from '@server/entity/DownloadCheck';
import DownloadCheck from '@server/entity/DownloadCheck';
import { User } from '@server/entity/User';
import downloadCheck from '@server/lib/downloadCheck';
import type { CheckServer, Grab, Removal } from '@server/lib/downloadCheck/arr';
import { Permission } from '@server/lib/permissions';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { isAuthenticated } from '@server/middleware/auth';
import backfillRoutes from '@server/routes/backfill';
import backfillSettingsRoutes from '@server/routes/settings/backfill';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Download Check through the real API validator: the findings an admin
 * sees, their choices, and the switch in Settings.
 */

setupTestDb();

let app: Server | undefined;
let port = 0;
let actingAs: User;
let admin: User;
let member: User;

const SONARR = {
  id: 0,
  name: 'Sonarr',
  hostname: 'sonarr.test',
  port: 8989,
  apiKey: 'key',
  useSsl: false,
  baseUrl: '',
} as SonarrSettings;

/** Just enough Sonarr for an admin's choice. */
const removed: { ids: number[]; how: Removal }[] = [];
let queue: Grab[] = [];
const fake = {
  app: 'sonarr',
  queue: async () => queue,
  remove: async (ids: number[], how: Removal) => {
    removed.push({ ids, how });
  },
  episodes: async () => [
    { id: 103, seasonNumber: 1, episodeNumber: 3, hasFile: false },
  ],
} as unknown as CheckServer;

const finding = (over: Partial<DownloadCheck>) =>
  getRepository(DownloadCheck).save(
    new DownloadCheck({
      app: 'sonarr',
      serverId: 0,
      downloadKey: 'abc',
      stage: 'grab',
      title: 'Show.S01E03.1080p',
      itemId: 10,
      itemTitle: 'Show',
      episodes: 'S01E03',
      finding: 'early',
      action: 'reject',
      status: 'would',
      params: JSON.stringify({ hours: 150 }),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    })
  );

const call = (method: 'get' | 'post' | 'put', url: string, data?: unknown) =>
  axios.request({
    method,
    url: `http://127.0.0.1:${port}/api/v1${url}`,
    data,
    validateStatus: () => true,
  });

beforeEach(async () => {
  removed.length = 0;
  queue = [];
  const users = getRepository(User);
  admin = await users.save(
    new User({
      email: 'dc-admin@test.local',
      plexUsername: 'dc-admin',
      permissions: Permission.ADMIN,
      avatar: '',
    })
  );
  member = await users.save(
    new User({
      email: 'dc-member@test.local',
      plexUsername: 'dc-member',
      permissions: Permission.MANAGE_REQUESTS,
      avatar: '',
    })
  );
  actingAs = admin;
  getSettings().sonarr = [SONARR];
  getSettings().radarr = [];
  mock.method(downloadCheck, 'apiFor', () => fake);

  if (!app) {
    const ex = express();
    ex.use(express.json());
    ex.use(
      OpenApiValidator.middleware({
        apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
        validateRequests: true,
        validateSecurity: false,
      })
    );
    ex.use((req, _res, next) => {
      (req as unknown as { user: User }).user = actingAs;
      next();
    });
    ex.use(
      '/api/v1/backfill',
      isAuthenticated(Permission.ADMIN),
      backfillRoutes
    );
    ex.use(
      '/api/v1/settings/backfill',
      isAuthenticated(Permission.ADMIN),
      backfillSettingsRoutes
    );
    ex.use(
      (
        err: { status?: number; message: string },
        _req: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: express.NextFunction
      ) => res.status(err.status ?? 500).json({ message: err.message })
    );
    app = await new Promise<Server>((resolve) => {
      const s = ex.listen(0, () => resolve(s));
    });
    port = (app.address() as { port: number }).port;
  }
});

afterEach(() => {
  mock.restoreAll();
  getSettings().backfill = {
    ...getSettings().backfill,
    downloadCheck: { mode: 'off' },
  };
});
after(() => app?.close());

describe('Download Check’s routes', () => {
  it('lists the newest and everything waiting, with the week counted', async () => {
    await finding({ downloadKey: 'a', status: 'done' });
    await finding({
      downloadKey: 'b',
      action: 'review',
      status: 'waiting',
      finding: 'unsureTitle',
    });
    const { status, data } = await call('get', '/backfill/download-check');
    assert.equal(status, 200);
    assert.equal(data.mode, 'off');
    assert.equal(data.waiting, 1);
    assert.deepEqual(data.week, {
      rejected: 1,
      imported: 0,
      cleared: 0,
      found: 2,
    });
    assert.deepEqual(
      data.rows.map(
        (r: { downloadKey?: string; title: string; server: string }) => [
          r.title,
          r.server,
        ]
      ),
      [
        ['Show.S01E03.1080p', 'Sonarr'],
        ['Show.S01E03.1080p', 'Sonarr'],
      ]
    );
    assert.deepEqual(data.rows[1].params, { hours: 150 });
  });

  it('is for admins only', async () => {
    actingAs = member;
    assert.equal((await call('get', '/backfill/download-check')).status, 403);
  });

  it('does what an admin chooses, while the download is still queued', async () => {
    const row = await finding({ downloadKey: 'abc' });
    queue = [
      {
        key: 'abc',
        downloadId: 'ABC',
        queueIds: [41],
        title: row.title,
        protocol: 'usenet',
        status: 'downloading',
        state: 'downloading',
        trackedStatus: 'ok',
        messages: [],
        size: 1,
        sizeLeft: 1,
        itemId: 10,
        episodes: [
          { id: 103, seasonNumber: 1, episodeNumber: 3, hasFile: false },
        ],
      },
    ];
    const { status, data } = await call(
      'post',
      `/backfill/download-check/${row.id}`,
      { choice: 'reject' }
    );
    assert.equal(status, 200);
    assert.equal(data.status, 'done');
    assert.deepEqual(removed, [
      {
        ids: [41],
        how: { removeFromClient: true, blocklist: true, skipRedownload: false },
      },
    ]);
    // Done once: not again.
    const again = await call('post', `/backfill/download-check/${row.id}`, {
      choice: 'reject',
    });
    assert.equal(again.status, 409);
  });

  it('says so when the download has left the queue', async () => {
    const row = await finding({});
    const { status, data } = await call(
      'post',
      `/backfill/download-check/${row.id}`,
      { choice: 'reject' }
    );
    assert.equal(status, 409);
    assert.match(data.message, /no longer in Sonarr's queue/);
    const back = await getRepository(DownloadCheck).findOneByOrFail({
      id: row.id,
    });
    assert.equal(back.status, 'gone' satisfies CheckStatus);
  });

  it('leaves a finding alone when told to, and refuses a choice it doesn’t know', async () => {
    const row = await finding({ action: 'review', status: 'waiting' });
    const bad = await call('post', `/backfill/download-check/${row.id}`, {
      choice: 'explode',
    });
    assert.equal(bad.status, 400);
    const { status, data } = await call(
      'post',
      `/backfill/download-check/${row.id}`,
      { choice: 'dismiss' }
    );
    assert.equal(status, 200);
    assert.equal(data.status, 'dismissed');
    assert.equal(removed.length, 0);
  });

  it('turns it to Report only from Settings', async () => {
    const { status, data } = await call(
      'put',
      '/settings/backfill/download-check',
      { mode: 'report' }
    );
    assert.equal(status, 200);
    assert.deepEqual(data, { mode: 'report' });
    assert.equal(getSettings().backfill.downloadCheck.mode, 'report');
    assert.equal(
      (await call('put', '/settings/backfill/download-check', { mode: 'loud' }))
        .status,
      400
    );
    const shown = await call('get', '/settings/backfill');
    assert.deepEqual(shown.data.downloadCheck, { mode: 'report' });
  });
});
