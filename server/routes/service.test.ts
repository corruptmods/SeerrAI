import RadarrAPI from '@server/api/servarr/radarr';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { Permission } from '@server/lib/permissions';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import serviceRoutes from '@server/routes/service';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';

/*
 * Radarr and Sonarr details for the request window, readable by anyone signed
 * in, when the server doesn't answer.
 */

let app: Server;
let port = 0;
/** A port nothing listens on. */
let closedPort = 0;
let warned: string[] = [];
/** Who asks; nobody for the requests above. */
let actingAs: User | undefined;

setupTestDb();

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port)
    )
  );

before(async () => {
  const closed = createServer();
  closedPort = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));

  const routes = express();
  routes.use((req, _res, next) => {
    req.user = actingAs;
    next();
  });
  routes.use('/service', serviceRoutes);
  // As the real server does: the error message goes to the client.
  routes.use(
    (
      err: { status?: number; message: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
  app = createServer(routes);
  port = await listen(app);
});

after(() => app.close());

beforeEach(() => {
  const server = {
    id: 0,
    name: 'Main',
    hostname: '127.0.0.1',
    port: closedPort,
    apiKey: 'the-api-key',
    useSsl: false,
    baseUrl: '',
    is4k: false,
    isDefault: true,
  };
  getSettings().radarr = [server as RadarrSettings];
  getSettings().sonarr = [server as SonarrSettings];
  warned = [];
  mock.method(logger, 'warn', (...args: unknown[]) => {
    warned.push(JSON.stringify(args));
    return logger;
  });
});

afterEach(() => {
  mock.restoreAll();
  actingAs = undefined;
});

describe('a Radarr or Sonarr that does not answer', () => {
  for (const kind of ['radarr', 'sonarr']) {
    it(`says so plainly for ${kind}, and logs where it tried`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}/service/${kind}/0`);
      const body = (await res.json()) as { message: string };
      assert.equal(res.status, 500);
      assert.doesNotMatch(body.message, /127\.0\.0\.1|ECONNREFUSED/);
      assert.match(body.message, /did not answer/);
      assert.equal(warned.length, 1);
      assert.match(warned[0], /ECONNREFUSED/);
      assert.doesNotMatch(warned[0], /the-api-key/);
    });
  }
});

describe('a Radarr server for the request window', () => {
  const stubRadarr = (name: string, value: unknown) =>
    Object.defineProperty(RadarrAPI.prototype, name, {
      configurable: true,
      set() {},
      get() {
        return async () => value;
      },
    });

  const person = async (email: string, permissions: number) => {
    const user = await getRepository(User).save(
      new User({ email, permissions, avatar: '' })
    );
    await getRepository(UserSettings).save(
      new UserSettings({
        user,
        defaultProfiles: [
          { service: 'radarr', serverId: 0, profileId: 5 },
          { service: 'radarr', serverId: 0, anime: true, profileId: 12 },
        ],
      })
    );
    return getRepository(User).findOneByOrFail({ id: user.id });
  };

  const details = async (query = '') =>
    (await (
      await fetch(`http://127.0.0.1:${port}/service/radarr/0${query}`)
    ).json()) as {
      savedProfileId?: number;
      savedAnimeProfileId?: number;
      server: { profileFolders: unknown };
    };

  beforeEach(() => {
    stubRadarr('getProfiles', [{ id: 5, name: 'Ultra' }]);
    stubRadarr('getRootFolders', []);
    stubRadarr('getTags', []);
    getSettings().radarr[0].activeAnimeProfileId = 9;
    getSettings().radarr[0].profileFolders = [
      { profileId: 5, rootFolder: '/ultra' },
    ];
  });

  it("gives its folders by profile and the asker's saved profiles", async () => {
    actingAs = await person(
      'glasswing@example.invalid',
      Permission.REQUEST | Permission.REQUEST_ADVANCED
    );

    const body = await details();

    assert.equal(body.savedProfileId, 5);
    assert.equal(body.savedAnimeProfileId, 12);
    assert.deepEqual(body.server.profileFolders, [
      { profileId: 5, rootFolder: '/ultra' },
    ]);
  });

  it('gives no saved profile to someone who may not choose one', async () => {
    actingAs = await person('harbour@example.invalid', Permission.REQUEST);

    assert.equal((await details()).savedProfileId, undefined);
  });

  it("gives someone else's only to those who request for others", async () => {
    const other = await person(
      'lantern@example.invalid',
      Permission.REQUEST | Permission.REQUEST_ADVANCED
    );
    actingAs = await person(
      'static@example.invalid',
      Permission.REQUEST | Permission.REQUEST_ADVANCED
    );
    assert.equal(
      (await details(`?requestUser=${other.id}`)).savedProfileId,
      undefined
    );

    actingAs = await person(
      'manager@example.invalid',
      Permission.MANAGE_REQUESTS
    );
    assert.equal((await details(`?requestUser=${other.id}`)).savedProfileId, 5);
  });
});
