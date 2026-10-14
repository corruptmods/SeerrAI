import { MediaServerType } from '@server/constants/server';
import { getSettings, jellyfinDefaults } from '@server/lib/settings';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Music libraries in Settings → Plex, Jellyfin and Emby: found by the same
 * library sync as the others but kept apart from them, and switched on and
 * off on their own, behind the real OpenAPI validator.
 */

setupTestDb();

const json = (res: ServerResponse, body: unknown) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

const plexStandIn = (req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/library/sections') {
    return json(res, {
      MediaContainer: {
        Directory: [
          {
            key: '1',
            title: 'Films',
            type: 'movie',
            agent: 'tv.plex.agents.movie',
          },
          {
            key: '2',
            title: 'Series',
            type: 'show',
            agent: 'tv.plex.agents.series',
          },
          // Music libraries count whatever their agent, none included.
          {
            key: '3',
            title: 'Music',
            type: 'artist',
            agent: 'com.plexapp.agents.none',
          },
          {
            key: '4',
            title: 'Home Videos',
            type: 'movie',
            agent: 'com.plexapp.agents.none',
          },
        ],
      },
    });
  }
  res.statusCode = 404;
  json(res, {});
};

const jellyfinStandIn =
  (name: string) => (req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith('/Library/MediaFolders')) {
      return json(res, {
        Items: [
          {
            Id: `${name}-films`,
            Name: 'Films',
            Type: 'CollectionFolder',
            CollectionType: 'movies',
          },
          {
            Id: `${name}-music`,
            Name: 'Music',
            Type: 'CollectionFolder',
            CollectionType: 'music',
          },
          {
            Id: `${name}-books`,
            Name: 'Books',
            Type: 'CollectionFolder',
            CollectionType: 'books',
          },
        ],
      });
    }
    res.statusCode = 404;
    json(res, {});
  };

const servers: Server[] = [];
const ports: Record<string, number> = {};

before(async () => {
  const listen = (name: string, app: http.RequestListener) =>
    new Promise<void>((resolve) => {
      const server = http.createServer(app).listen(0, () => {
        ports[name] = (server.address() as AddressInfo).port;
        resolve();
      });
      servers.push(server);
    });
  await listen('plex', plexStandIn);
  await listen('jellyfin', jellyfinStandIn('jellyfin'));
  await listen('emby', jellyfinStandIn('emby'));

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
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
  await listen('app', app);
});

after(() => servers.forEach((server) => server.close()));

beforeEach(() => {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.main.disabledFeatures = [];
  Object.assign(settings.plex, {
    ip: '127.0.0.1',
    port: ports.plex,
    useSsl: false,
    connected: true,
    libraries: [],
    musicLibraries: [],
  });
  for (const kind of ['jellyfin', 'emby'] as const) {
    settings[kind] = {
      ...jellyfinDefaults(),
      ip: '127.0.0.1',
      port: ports[kind],
      apiKey: `${kind}-key`,
      connected: true,
    };
  }
});

const api = (pathname: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${ports.app}/api/v1/settings${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  });

describe('music libraries', () => {
  it('are synced with Plex’s libraries and kept apart from them', async () => {
    const synced = await api('/plex/library/sync', { method: 'POST' });
    assert.equal(synced.status, 200);
    // The answer is the film and series libraries, as before.
    assert.deepEqual(
      ((await synced.json()) as { id: string }[]).map((library) => library.id),
      ['1', '2']
    );
    assert.deepEqual(getSettings().plex.musicLibraries, [
      {
        id: '3',
        name: 'Music',
        enabled: false,
        type: 'artist',
        lastScan: undefined,
      },
    ]);

    const toggled = await api('/plex/music-library/3', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(toggled.status, 200);
    assert.equal(getSettings().plex.musicLibraries[0].enabled, true);
    // Switched on stays on through the next sync.
    await api('/plex/library/sync', { method: 'POST' });
    assert.equal(getSettings().plex.musicLibraries[0].enabled, true);
    assert.equal(getSettings().plex.libraries.length, 2);

    const listed = await api('/plex/music-library');
    assert.equal(listed.status, 200);
    assert.deepEqual(
      ((await listed.json()) as { id: string }[]).map((library) => library.id),
      ['3']
    );
    assert.equal(
      (
        await api('/plex/music-library/1', {
          method: 'PUT',
          body: JSON.stringify({ enabled: true }),
        })
      ).status,
      404
    );
  });

  for (const kind of ['jellyfin', 'emby'] as const) {
    it(`are synced with ${kind}’s libraries and switched on their own`, async () => {
      const synced = await api(`/${kind}/library/sync`, { method: 'POST' });
      assert.equal(synced.status, 200);
      const settings = getSettings();
      assert.deepEqual(
        settings[kind].libraries.map((library) => library.id),
        [`${kind}-films`]
      );
      assert.deepEqual(
        settings[kind].musicLibraries.map((library) => [
          library.id,
          library.type,
        ]),
        [[`${kind}-music`, 'music']]
      );

      const toggled = await api(`/${kind}/music-library/${kind}-music`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(toggled.status, 200);
      assert.equal(settings[kind].musicLibraries[0].enabled, true);
      // The other server's are its own.
      const other = kind === 'jellyfin' ? 'emby' : 'jellyfin';
      assert.deepEqual(settings[other].musicLibraries, []);
    });
  }

  it('are not there while music is off for everyone', async () => {
    getSettings().main.disabledFeatures = ['music'];
    getSettings().plex.musicLibraries = [
      { id: '3', name: 'Music', enabled: false, type: 'artist' },
    ];

    assert.equal((await api('/plex/music-library')).status, 403);
    assert.equal(
      (
        await api('/emby/music-library/emby-music', {
          method: 'PUT',
          body: JSON.stringify({ enabled: true }),
        })
      ).status,
      403
    );
    assert.equal(getSettings().plex.musicLibraries[0].enabled, false);
  });
});
