import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import {
  getMaintainerrStatus,
  refreshDeletingSoon,
  resetDeletingSoonForTests,
} from '@server/lib/deletingSoon';
import { Permission } from '@server/lib/permissions';
import type { MaintainerrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import migrateMaintainerrServers from '@server/lib/settings/migrations/0009_maintainerr_servers';
import maintainerrRoutes from '@server/routes/maintainerr';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Maintainerr integration against two fake Maintainerr servers that speak its
 * real API shapes, with Seerr's routes behind the real OpenAPI validator.
 */

setupTestDb();

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

interface FakeCollection {
  id: number;
  title: string;
  isActive: boolean;
  arrAction: number;
  deleteAfterDays: number | null;
  type: string;
}
interface FakeMedia {
  id: number;
  collectionId: number;
  mediaServerId: string;
  tmdbId: number | null;
  addDate: string;
}
interface Fake {
  up: boolean;
  collections: FakeCollection[];
  media: Record<number, FakeMedia[]>;
  postpones: { collectionId: number; mediaId: string; days?: number }[];
  server: http.Server;
  port: number;
}

const makeFake = async (): Promise<Fake> => {
  const fake = {
    up: true,
    collections: [],
    media: {},
    postpones: [],
  } as unknown as Fake;
  fake.server = http.createServer((req, res) => {
    if (!fake.up) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/settings/version') return send('2.20.0');
    if (url.pathname === '/api/collections') return send(fake.collections);
    if (url.pathname === '/api/collections/media/') {
      return send(
        fake.media[Number(url.searchParams.get('collectionId'))] ?? []
      );
    }
    if (url.pathname === '/api/collections/media/postpone') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        fake.postpones.push(body);
        const item = fake.media[body.collectionId]?.find(
          (m) => m.mediaServerId === body.mediaId
        );
        if (item) {
          // Maintainerr restarts the countdown when no days are given.
          item.addDate = body.days
            ? new Date(
                new Date(item.addDate).getTime() + body.days * DAY
              ).toISOString()
            : new Date().toISOString();
        }
        send({ ok: true });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', () => r()));
  fake.port = (fake.server.address() as { port: number }).port;
  return fake;
};

let a: Fake;
let b: Fake;

const seed = () => {
  for (const fake of [a, b]) {
    fake.up = true;
    fake.postpones = [];
  }
  a.collections = [
    {
      id: 1,
      title: 'Old movies',
      isActive: true,
      arrAction: 0,
      deleteAfterDays: 30,
      type: 'movie',
    },
    {
      id: 2,
      title: 'Stale shows',
      isActive: true,
      arrAction: 1,
      deleteAfterDays: 10,
      type: 'show',
    },
    // None of these delete a whole title:
    {
      id: 3,
      title: 'Unmonitor only',
      isActive: true,
      arrAction: 3,
      deleteAfterDays: 5,
      type: 'movie',
    },
    {
      id: 4,
      title: 'Do nothing',
      isActive: true,
      arrAction: 4,
      deleteAfterDays: 5,
      type: 'movie',
    },
    {
      id: 5,
      title: 'Paused rule',
      isActive: false,
      arrAction: 0,
      deleteAfterDays: 5,
      type: 'movie',
    },
    {
      id: 6,
      title: 'Old seasons',
      isActive: true,
      arrAction: 0,
      deleteAfterDays: 5,
      type: 'season',
    },
    {
      id: 7,
      title: 'No window',
      isActive: true,
      arrAction: 0,
      deleteAfterDays: null,
      type: 'movie',
    },
  ];
  a.media = {
    1: [
      {
        id: 1,
        collectionId: 1,
        mediaServerId: 'a-101',
        tmdbId: 101,
        addDate: daysAgo(25),
      }, // 5 days
      {
        id: 2,
        collectionId: 1,
        mediaServerId: 'a-102',
        tmdbId: 102,
        addDate: daysAgo(1),
      }, // 29 days
      {
        id: 3,
        collectionId: 1,
        mediaServerId: 'a-x',
        tmdbId: null,
        addDate: daysAgo(29),
      },
    ],
    2: [
      {
        id: 4,
        collectionId: 2,
        mediaServerId: 'a-201',
        tmdbId: 201,
        addDate: daysAgo(8),
      },
    ], // 2 days
    3: [
      {
        id: 5,
        collectionId: 3,
        mediaServerId: 'a-301',
        tmdbId: 301,
        addDate: daysAgo(4),
      },
    ],
    4: [
      {
        id: 6,
        collectionId: 4,
        mediaServerId: 'a-401',
        tmdbId: 401,
        addDate: daysAgo(4),
      },
    ],
    5: [
      {
        id: 7,
        collectionId: 5,
        mediaServerId: 'a-501',
        tmdbId: 501,
        addDate: daysAgo(4),
      },
    ],
    6: [
      {
        id: 8,
        collectionId: 6,
        mediaServerId: 'a-601',
        tmdbId: 601,
        addDate: daysAgo(4),
      },
    ],
    7: [
      {
        id: 9,
        collectionId: 7,
        mediaServerId: 'a-701',
        tmdbId: 701,
        addDate: daysAgo(4),
      },
    ],
  };
  // A second server also holds movie 101, sooner; and one title of its own.
  b.collections = [
    {
      id: 40,
      title: 'Low rated',
      isActive: true,
      arrAction: 0,
      deleteAfterDays: 7,
      type: 'movie',
    },
  ];
  b.media = {
    40: [
      {
        id: 1,
        collectionId: 40,
        mediaServerId: 'b-101',
        tmdbId: 101,
        addDate: daysAgo(6),
      }, // 1 day
      {
        id: 2,
        collectionId: 40,
        mediaServerId: 'b-150',
        tmdbId: 150,
        addDate: daysAgo(4),
      }, // 3 days
    ],
  };
};

const server = (
  fake: Fake,
  id: number,
  overrides: Partial<MaintainerrSettings> = {}
): MaintainerrSettings => ({
  id,
  name: `Server ${id}`,
  hostname: '127.0.0.1',
  port: fake.port,
  useSsl: false,
  urlBase: '',
  apiKey: '',
  showBadges: true,
  showDeletingSoon: true,
  allowKeep: true,
  keepDays: 0,
  soonDays: 14,
  ...overrides,
});

// ---- Seerr ------------------------------------------------------------------
let app: Server;
let port: number;
let actingAs: User;
let admin: User;
let member: User;

const call = <T = unknown>(method: string, route: string, body?: unknown) =>
  new Promise<{ status: number; body: T }>((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : undefined,
          })
        );
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

type Item = {
  mediaId: number | null;
  tmdbId: number;
  mediaType: string;
  deleteAt: string;
  showBadge: boolean;
  showInRow: boolean;
  canKeep: boolean;
};
const deleting = async () =>
  (
    await call<{ enabled: boolean; items: Item[] }>(
      'GET',
      '/api/v1/maintainerr/deleting'
    )
  ).body;
const daysLeft = (iso: string) =>
  Math.round((new Date(iso).getTime() - Date.now()) / DAY);
const find = (items: Item[], tmdbId: number) =>
  items.find((i) => i.tmdbId === tmdbId);

before(async () => {
  a = await makeFake();
  b = await makeFake();
});

beforeEach(async () => {
  seed();
  resetDeletingSoonForTests();
  getSettings().maintainerr = [server(a, 0), server(b, 1)];

  await getRepository(User).save(
    new User({
      email: 'm-admin@test.local',
      plexUsername: 'm-admin',
      permissions: Permission.ADMIN,
      avatar: '',
    })
  );
  await getRepository(User).save(
    new User({
      email: 'm-member@test.local',
      plexUsername: 'm-member',
      permissions: Permission.REQUEST,
      avatar: '',
    })
  );
  admin = await getRepository(User).findOneOrFail({
    where: { plexUsername: 'm-admin' },
  });
  member = await getRepository(User).findOneOrFail({
    where: { plexUsername: 'm-member' },
  });
  actingAs = member;

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
    ex.use('/api/v1/maintainerr', maintainerrRoutes);
    ex.use('/api/v1/settings', settingsRoutes);
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

after(() => {
  app?.close();
  a?.server.close();
  b?.server.close();
});

describe('what counts as deleting soon', () => {
  it('lists only titles a rule will actually delete, within the window, from every server', async () => {
    const { enabled, items } = await deleting();
    assert.equal(enabled, true);
    assert.deepEqual(
      items.map((i) => `${i.mediaType}:${i.tmdbId}`).sort(),
      ['movie:101', 'movie:150', 'tv:201'],
      'unmonitor, do nothing, paused, season, no-window and far-off titles are left out'
    );
  });

  it('uses the soonest date when two servers hold a title', async () => {
    const { items } = await deleting();
    assert.equal(
      daysLeft(find(items, 101)!.deleteAt),
      1,
      "server B's 1 day beats server A's 5"
    );
  });

  it('copes with a rule matching more titles than SQLite takes in one query', async () => {
    a.media[1] = Array.from({ length: 1200 }, (_, i) => ({
      id: 10000 + i,
      collectionId: 1,
      mediaServerId: `bulk-${i}`,
      tmdbId: 90000 + i,
      addDate: daysAgo(25),
    }));
    resetDeletingSoonForTests();
    const kept = await getRepository(Media).save(
      new Media({
        tmdbId: 91150,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
      })
    );

    const res = await call<{ items: Item[] }>(
      'GET',
      '/api/v1/maintainerr/deleting'
    );

    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 1200);
    assert.equal(find(res.body.items, 91150)?.mediaId, kept.id);
  });

  it("carries Seerr's own media id, never a TMDB id in its place", async () => {
    const saved = await getRepository(Media).save(
      new Media({
        tmdbId: 101,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
      })
    );
    const { items } = await deleting();
    assert.equal(find(items, 101)?.mediaId, saved.id);
    assert.equal(
      find(items, 201)?.mediaId,
      null,
      'no Seerr record: null, not a guess'
    );
  });

  it("applies each server's own switches to its own titles", async () => {
    getSettings().maintainerr = [
      server(a, 0, { showBadges: false, showDeletingSoon: false }),
      server(b, 1),
    ];
    const { items } = await deleting();
    assert.deepEqual(
      [find(items, 201)!.showBadge, find(items, 201)!.showInRow],
      [false, false],
      'A-only title follows A'
    );
    assert.deepEqual(
      [find(items, 150)!.showBadge, find(items, 150)!.showInRow],
      [true, true],
      'B-only title follows B'
    );
  });

  it("uses each server's own window for what counts as soon", async () => {
    getSettings().maintainerr = [server(a, 0, { soonDays: 1 }), server(b, 1)];
    const { items } = await deleting();
    assert.equal(
      find(items, 201),
      undefined,
      'A title 2 days out, A counts 1 day as soon'
    );
    assert.ok(find(items, 150), 'B still shows its own');
  });

  it("keeps one server's last good answer when it goes away, and names it", async () => {
    await deleting();
    a.up = false;
    await refreshDeletingSoon();
    const { items } = await deleting();
    assert.ok(find(items, 201), "A's titles do not vanish on a blip");
    const status = getMaintainerrStatus();
    assert.ok(
      status.find((s) => s.id === 0)?.lastError,
      'the failure is recorded against A'
    );
    assert.equal(
      status.find((s) => s.id === 1)?.lastError,
      null,
      'B is unaffected'
    );
  });

  it('reports nothing with no servers', async () => {
    getSettings().maintainerr = [];
    assert.deepEqual(await deleting(), { enabled: false, items: [] });
  });
});

describe('Keep', () => {
  it('postpones in every rule on every server that would delete it', async () => {
    const { status, body } = await call<{ deleteAt: string | null }>(
      'POST',
      '/api/v1/maintainerr/keep',
      { tmdbId: 101, mediaType: 'movie' }
    );
    assert.equal(status, 200);
    assert.deepEqual(a.postpones, [{ collectionId: 1, mediaId: 'a-101' }]);
    assert.deepEqual(b.postpones, [{ collectionId: 40, mediaId: 'b-101' }]);
    assert.equal(
      body.deleteAt ? daysLeft(body.deleteAt) : null,
      7,
      "now due when B's shorter rule next comes round"
    );
  });

  it("adds each server's own number of days when set", async () => {
    getSettings().maintainerr = [
      server(a, 0, { keepDays: 7 }),
      server(b, 1, { keepDays: 3 }),
    ];
    await call('POST', '/api/v1/maintainerr/keep', {
      tmdbId: 101,
      mediaType: 'movie',
    });
    assert.deepEqual(a.postpones, [
      { collectionId: 1, mediaId: 'a-101', days: 7 },
    ]);
    assert.deepEqual(b.postpones, [
      { collectionId: 40, mediaId: 'b-101', days: 3 },
    ]);
  });

  it('is not offered, and refused, when a server about to delete it does not allow it', async () => {
    getSettings().maintainerr = [
      server(a, 0),
      server(b, 1, { allowKeep: false }),
    ];
    const { items } = await deleting();
    assert.equal(
      find(items, 101)!.canKeep,
      false,
      'keeping on A alone would not stop B'
    );
    assert.equal(
      find(items, 201)!.canKeep,
      true,
      'an A-only title can still be kept'
    );

    const { status } = await call('POST', '/api/v1/maintainerr/keep', {
      tmdbId: 101,
      mediaType: 'movie',
    });
    assert.equal(status, 403);
    assert.equal(a.postpones.length + b.postpones.length, 0);
  });

  it('is refused while Deleting Soon is turned off', async () => {
    const wasOff = getSettings().main.disabledFeatures;
    getSettings().main.disabledFeatures = ['deletingSoon'];
    try {
      const { status } = await call('POST', '/api/v1/maintainerr/keep', {
        tmdbId: 101,
        mediaType: 'movie',
      });
      assert.equal(status, 403);
      assert.equal(a.postpones.length + b.postpones.length, 0);
    } finally {
      getSettings().main.disabledFeatures = wasOff;
    }
  });

  it('says so for a title that is not scheduled', async () => {
    const { status } = await call('POST', '/api/v1/maintainerr/keep', {
      tmdbId: 999,
      mediaType: 'movie',
    });
    assert.equal(status, 404);
  });

  it('reports a Maintainerr failure without pretending it worked', async () => {
    await deleting();
    a.up = false;
    const { status } = await call('POST', '/api/v1/maintainerr/keep', {
      tmdbId: 201,
      mediaType: 'tv',
    });
    assert.equal(status, 502);
  });
});

describe('Maintainerr servers in settings', () => {
  beforeEach(() => {
    actingAs = admin;
    getSettings().maintainerr = [];
  });

  it('adds a server after a successful test, numbering it one past the highest', async () => {
    const first = await call<MaintainerrSettings>(
      'POST',
      '/api/v1/settings/maintainerr',
      { ...server(a, 0), id: undefined }
    );
    assert.equal(first.status, 201);
    assert.equal(first.body.id, 0);

    const second = await call<MaintainerrSettings>(
      'POST',
      '/api/v1/settings/maintainerr',
      { ...server(b, 0), id: undefined, name: 'Second' }
    );
    assert.equal(second.body.id, 1);

    await call('DELETE', '/api/v1/settings/maintainerr/1');
    const third = await call<MaintainerrSettings>(
      'POST',
      '/api/v1/settings/maintainerr',
      { ...server(b, 0), id: undefined, name: 'Third' }
    );
    assert.equal(third.body.id, 1, 'one past the highest remaining');

    const { body } = await call<MaintainerrSettings[]>(
      'GET',
      '/api/v1/settings/maintainerr'
    );
    assert.deepEqual(
      body.map((s) => s.name),
      ['Server 0', 'Third']
    );
  });

  it('refuses a server it cannot reach, adding nothing', async () => {
    const { status } = await call('POST', '/api/v1/settings/maintainerr', {
      ...server(a, 0),
      port: 1,
    });
    assert.equal(status, 500);
    assert.deepEqual(getSettings().maintainerr, []);
  });

  it('edits a server, testing it first, and leaves it alone if the test fails', async () => {
    getSettings().maintainerr = [server(a, 0)];

    const ok = await call<MaintainerrSettings>(
      'PUT',
      '/api/v1/settings/maintainerr/0',
      { ...server(a, 0), name: 'Renamed' }
    );
    assert.equal(ok.status, 200);
    assert.equal(getSettings().maintainerr[0].name, 'Renamed');

    const bad = await call('PUT', '/api/v1/settings/maintainerr/0', {
      ...server(a, 0),
      name: 'Broken',
      port: 1,
    });
    assert.equal(bad.status, 500);
    assert.equal(getSettings().maintainerr[0].name, 'Renamed');
  });

  it('deletes a server', async () => {
    getSettings().maintainerr = [server(a, 0), server(b, 1)];
    assert.equal(
      (await call('DELETE', '/api/v1/settings/maintainerr/0')).status,
      200
    );
    assert.deepEqual(
      getSettings().maintainerr.map((s) => s.id),
      [1]
    );
    assert.equal(
      (await call('DELETE', '/api/v1/settings/maintainerr/9')).status,
      404
    );
  });

  it('tests a connection without needing a name', async () => {
    const { status, body } = await call<{ version: string }>(
      'POST',
      '/api/v1/settings/maintainerr/test',
      { hostname: '127.0.0.1', port: a.port }
    );
    assert.equal(status, 200);
    assert.equal(body.version, '2.20.0');
  });
});

describe('moving from one server to a list', () => {
  const old = {
    enabled: true,
    hostname: 'maint.lan',
    port: 6246,
    useSsl: false,
    urlBase: '',
    apiKey: '',
    showBadges: false,
    showDeletingSoon: true,
    allowKeep: true,
    keepDays: 5,
    soonDays: 10,
    notifyUsers: true,
    notifyDaysBefore: 3,
  };

  it('turns a configured server into the first entry, keeping its switches', () => {
    const migrated = migrateMaintainerrServers({
      maintainerr: old,
      migrations: [],
    } as never);
    assert.deepEqual(migrated.maintainerr, [
      {
        id: 0,
        name: 'Maintainerr',
        hostname: 'maint.lan',
        port: 6246,
        useSsl: false,
        urlBase: '',
        apiKey: '',
        showBadges: false,
        showDeletingSoon: true,
        allowKeep: true,
        keepDays: 5,
        soonDays: 10,
      },
    ]);
  });

  it('does not bring a switched-off or unset server to life', () => {
    assert.deepEqual(
      migrateMaintainerrServers({
        maintainerr: { ...old, enabled: false },
        migrations: [],
      } as never).maintainerr,
      []
    );
    assert.deepEqual(
      migrateMaintainerrServers({
        maintainerr: { ...old, hostname: '' },
        migrations: [],
      } as never).maintainerr,
      []
    );
  });

  it('leaves a list, and runs once', () => {
    const list = [{ id: 3, name: 'X' }];
    const once = migrateMaintainerrServers({
      maintainerr: list,
      migrations: [],
    } as never);
    assert.deepEqual(once.maintainerr, list);
    const twice = migrateMaintainerrServers({
      maintainerr: old,
      migrations: ['0009_maintainerr_servers'],
    } as never);
    assert.deepEqual(twice.maintainerr, old, 'already applied: untouched');
  });
});
