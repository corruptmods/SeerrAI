import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { getSettings, jellyfinDefaults } from '@server/lib/settings';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { IncomingMessage, Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Settings → Emby: the same settings pages and calls as Jellyfin's, for
 * Emby's own settings, against stand-ins that answer as the servers do,
 * behind the real OpenAPI validator.
 */

setupTestDb();

const EMBY_USER = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const OTHER_USER = 'ffffffffffffffffffffffffffffffff';

let embyPort = 0;
let jellyfinPort = 0;
let port = 0;
const servers: Server[] = [];
const embyRequests: { url: string; auth: string }[] = [];

/** A stand-in Jellyfin or Emby server, checking its API key. */
const standIn =
  (name: string, key: string, seen?: typeof embyRequests) =>
  (req: IncomingMessage, res: http.ServerResponse) => {
    const auth = String(req.headers.authorization ?? '');
    seen?.push({ url: req.url ?? '', auth });
    res.setHeader('Content-Type', 'application/json');
    if (!auth.includes(`Token="${key}"`)) {
      res.statusCode = 401;
      return res.end('{}');
    }
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname === '/System/Info') {
      return res.end(JSON.stringify({ Id: `${name}-id`, ServerName: name }));
    }
    if (url.pathname === '/Library/MediaFolders') {
      return res.end(
        JSON.stringify({
          Items: [
            {
              Id: `${name}-films`,
              Name: 'Films',
              Type: 'CollectionFolder',
              CollectionType: 'movies',
            },
            {
              Id: `${name}-series`,
              Name: 'Series',
              Type: 'CollectionFolder',
              CollectionType: 'tvshows',
            },
          ],
        })
      );
    }
    if (url.pathname === '/Users') {
      return res.end(
        JSON.stringify([
          { Id: EMBY_USER, Name: 'already-here', ServerId: 's' },
          { Id: OTHER_USER, Name: 'new-person', ServerId: 's' },
        ])
      );
    }
    res.statusCode = 404;
    res.end('{}');
  };

before(async () => {
  const listen = (app: http.RequestListener) =>
    new Promise<number>((resolve) => {
      const server = http.createServer(app).listen(0, () => {
        resolve((server.address() as AddressInfo).port);
      });
      servers.push(server);
    });

  embyPort = await listen(standIn('Den Emby', 'emby-key', embyRequests));
  jellyfinPort = await listen(standIn('Den Jellyfin', 'jellyfin-key'));

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
  port = await listen(app);
});

after(() => servers.forEach((server) => server.close()));

beforeEach(() => {
  embyRequests.length = 0;
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.EMBY;
  settings.emby = {
    ...jellyfinDefaults(),
    ip: '127.0.0.1',
    port: embyPort,
    apiKey: 'emby-key',
    connected: true,
  };
  settings.jellyfin = {
    ...jellyfinDefaults(),
    ip: '127.0.0.1',
    port: jellyfinPort,
    apiKey: 'jellyfin-key',
    name: 'Untouched',
  };
});

const api = (route: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${port}/api/v1/settings${route}`, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  });

describe('Settings → Emby', () => {
  it("reads and saves Emby's settings, not Jellyfin's", async () => {
    const read = await api('/emby');
    assert.equal(read.status, 200);
    assert.equal((await read.json()).port, embyPort);

    // Whether Emby is connected is not changed from here.
    const disconnect = await api('/emby', {
      method: 'POST',
      body: JSON.stringify({ connected: false }),
    });
    assert.equal(disconnect.status, 400);

    const saved = await api('/emby', {
      method: 'POST',
      body: JSON.stringify({
        ip: '127.0.0.1',
        port: embyPort,
        externalHostname: 'https://emby.example.com',
      }),
    });
    assert.equal(saved.status, 200);
    const settings = getSettings();
    assert.equal(settings.emby.name, 'Den Emby');
    assert.equal(settings.emby.serverId, 'Den Emby-id');
    assert.equal(settings.emby.externalHostname, 'https://emby.example.com');
    assert.equal(settings.emby.connected, true);
    assert.equal(settings.jellyfin.name, 'Untouched');
    assert.ok(
      embyRequests.every((r) => r.auth.includes('Version="1.0.0"')),
      'spoken to as Emby'
    );

    const jellyfin = await api('/jellyfin');
    assert.equal((await jellyfin.json()).name, 'Untouched');
  });

  it("syncs and switches Emby's libraries", async () => {
    const synced = await api('/emby/library/sync', { method: 'POST' });
    assert.equal(synced.status, 200);
    assert.deepEqual(
      getSettings().emby.libraries.map((library) => library.id),
      ['Den Emby-films', 'Den Emby-series']
    );
    assert.deepEqual(getSettings().jellyfin.libraries, []);

    const toggled = await api('/emby/library/Den%20Emby-films', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(toggled.status, 200);
    assert.equal(getSettings().emby.libraries[0].enabled, true);

    const listed = await api('/emby/library');
    assert.equal((await listed.json()).length, 2);
  });

  it('lists the Emby people not yet imported', async () => {
    await getRepository(User).update(1, { embyUserId: EMBY_USER });
    // The same id on Jellyfin is another server's account.
    await getRepository(User).update(2, { jellyfinUserId: OTHER_USER });

    const res = await api('/emby/users');
    assert.equal(res.status, 200);
    const users = await res.json();
    assert.deepEqual(
      users.map((user: { username: string }) => user.username),
      ['new-person']
    );
    assert.equal(users[0].thumb, `/avatarproxy/${OTHER_USER}?server=emby`);
  });

  it("reports Emby's own scan", async () => {
    const res = await api('/emby/sync');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).running, false);
  });
});

describe('Settings → General and the media servers', () => {
  it('does not change the primary server', async () => {
    const res = await api('/main', {
      method: 'POST',
      body: JSON.stringify({ mediaServerType: MediaServerType.PLEX }),
    });
    assert.equal(res.status, 200);
    assert.equal(getSettings().main.mediaServerType, MediaServerType.EMBY);
  });

  it("turns each connected server's sign-in with the one switch", async () => {
    const settings = getSettings();
    settings.plex.connected = false;
    settings.plex.signIn = true;
    const off = await api('/main', {
      method: 'POST',
      body: JSON.stringify({ mediaServerLogin: false }),
    });
    assert.equal(off.status, 200);
    assert.equal(settings.main.mediaServerLogin, false);
    assert.equal(settings.emby.signIn, false);
    assert.equal(settings.plex.signIn, true, 'not connected: left alone');

    await api('/main', {
      method: 'POST',
      body: JSON.stringify({ mediaServerLogin: true }),
    });
    assert.equal(settings.emby.signIn, true);
  });
});
