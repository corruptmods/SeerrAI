import animeList from '@server/api/animelist';
import type {
  JellyfinLibraryItem,
  JellyfinLoginResponse,
} from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { splitEmbyData } from '@server/lib/embySplit';
import {
  embyFullScanner,
  jellyfinFullScanner,
} from '@server/lib/scanners/jellyfin';
import { getSettings, jellyfinDefaults } from '@server/lib/settings';
import migrateMediaServers from '@server/lib/settings/migrations/0010_media_servers';
import { maySignIn } from '@server/lib/signIn';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { checkAvatarChanged } from '@server/routes/avatarproxy';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import express from 'express';
import session from 'express-session';
import schedule from 'node-schedule';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';

setupTestDb();

/*
 * An Emby install upgrading: its settings move to Emby's own block (settings
 * migration 0010), then at startup the ids Emby gave titles and people move
 * to Emby's own columns, once. Afterwards it works as before: people sign
 * in with Emby, scans find titles, avatars and play links resolve, and
 * Quick Connect (Jellyfin's alone) is still not offered.
 */

const EMBY_SERVER = {
  ...jellyfinDefaults(),
  name: 'Den Emby',
  ip: 'emby.lan',
  port: 8096,
  externalHostname: 'https://emby.example.com',
  serverId: 'emby-server',
  apiKey: 'emby-key',
  libraries: [{ id: 'films', name: 'Films', enabled: true, type: 'movie' }],
};
const PERSON_ID = 'cccccccccccccccccccccccccccccccc';

/** The settings of an Emby install, as migration 0010 leaves them. */
const upgradeSettings = () => {
  const settings = getSettings();
  const migrated = migrateMediaServers({
    main: { mediaServerType: MediaServerType.EMBY, mediaServerLogin: true },
    plex: { ...settings.plex },
    jellyfin: { ...EMBY_SERVER },
    jobs: {},
    migrations: [],
  });
  settings.main.mediaServerType = MediaServerType.EMBY;
  settings.main.mediaServerLogin = true;
  settings.main.newPlexLogin = true;
  settings.plex = migrated.plex;
  settings.jellyfin = migrated.jellyfin;
  settings.emby = migrated.emby;
  settings.pendingEmbySplit = !!(migrated as { pendingEmbySplit?: boolean })
    .pendingEmbySplit;
};

/** What an Emby install's database held: Emby's ids in Jellyfin's columns. */
const seedEmbyInstall = async () => {
  const users = getRepository(User);
  await users.update(1, {
    plexId: null,
    userType: UserType.EMBY,
    jellyfinUserId: 'owner-emby-id',
    jellyfinUsername: 'owner',
    jellyfinDeviceId: 'BOT_seerr',
    jellyfinAuthToken: 'owner-token',
  });
  const person = await users.save(
    new User({
      email: 'person',
      jellyfinUserId: PERSON_ID,
      jellyfinUsername: 'person',
      jellyfinDeviceId: 'person-device',
      userType: UserType.EMBY,
      avatar: `/avatarproxy/${PERSON_ID}?v=old`,
      avatarVersion: 'old',
      permissions: 0,
    })
  );
  const film = await getRepository(Media).save(
    new Media({
      tmdbId: 603,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.AVAILABLE,
      jellyfinMediaId: 'emby-603',
      jellyfinMediaId4k: 'emby-603-4k',
    })
  );
  const unscanned = await getRepository(Media).save(
    new Media({ tmdbId: 604, mediaType: MediaType.MOVIE })
  );
  return { person, film, unscanned };
};

beforeEach(() => {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.NOT_CONFIGURED;
  settings.pendingEmbySplit = false;
  settings.jellyfin = jellyfinDefaults();
  settings.emby = jellyfinDefaults();
});

describe("moving an Emby install's ids", () => {
  it('moves titles and people to the Emby columns once, then clears the flag', async () => {
    upgradeSettings();
    const { person, film, unscanned } = await seedEmbyInstall();
    assert.equal(getSettings().pendingEmbySplit, true);

    await splitEmbyData();

    const movedFilm = await getRepository(Media).findOneByOrFail({
      id: film.id,
    });
    assert.equal(movedFilm.embyMediaId, 'emby-603');
    assert.equal(movedFilm.embyMediaId4k, 'emby-603-4k');
    assert.equal(movedFilm.jellyfinMediaId, null);
    assert.equal(movedFilm.jellyfinMediaId4k, null);
    assert.equal(movedFilm.status, MediaStatus.AVAILABLE);
    const untouched = await getRepository(Media).findOneByOrFail({
      id: unscanned.id,
    });
    assert.equal(untouched.embyMediaId, null);

    const movedPerson = await getRepository(User)
      .createQueryBuilder('user')
      .addSelect([
        'user.embyDeviceId',
        'user.embyAuthToken',
        'user.jellyfinDeviceId',
      ])
      .where('user.id = :id', { id: person.id })
      .getOneOrFail();
    assert.equal(movedPerson.embyUserId, PERSON_ID);
    assert.equal(movedPerson.embyUsername, 'person');
    assert.equal(movedPerson.embyDeviceId, 'person-device');
    assert.equal(movedPerson.jellyfinUserId, null);
    assert.equal(movedPerson.jellyfinUsername, null);
    assert.equal(movedPerson.jellyfinDeviceId, null);
    assert.equal(movedPerson.userType, UserType.EMBY);
    assert.equal(movedPerson.avatar, `/avatarproxy/${PERSON_ID}?v=old`);
    assert.equal(movedPerson.displayName, 'person');
    assert.deepEqual(movedPerson.linkedServers, ['emby']);

    const owner = await getRepository(User)
      .createQueryBuilder('user')
      .addSelect(['user.embyAuthToken'])
      .where('user.id = 1')
      .getOneOrFail();
    assert.equal(owner.embyUserId, 'owner-emby-id');
    assert.equal(owner.embyAuthToken, 'owner-token');

    // The Plex account seeded for the second test user is left alone.
    const plexUser = await getRepository(User).findOneByOrFail({ id: 2 });
    assert.equal(plexUser.embyUserId, null);
    assert.equal(plexUser.plexUsername, 'friend');

    assert.equal(getSettings().pendingEmbySplit, false);

    // A second start moves nothing: new Jellyfin ids stay Jellyfin's.
    await getRepository(Media).update(film.id, { jellyfinMediaId: 'jf-603' });
    await splitEmbyData();
    const again = await getRepository(Media).findOneByOrFail({ id: film.id });
    assert.equal(again.jellyfinMediaId, 'jf-603');
    assert.equal(again.embyMediaId, 'emby-603');
  });

  it('records the Jellyfin-typed accounts of an old Emby install as Emby ones', async () => {
    // Installs that told Emby apart only by JELLYFIN_TYPE recorded their
    // people as Jellyfin accounts.
    upgradeSettings();
    const { person } = await seedEmbyInstall();
    await getRepository(User).update(person.id, {
      userType: UserType.JELLYFIN,
    });
    const local = await getRepository(User).save(
      new User({
        email: 'local@example.com',
        userType: UserType.LOCAL,
        avatar: '',
      })
    );

    await splitEmbyData();

    const moved = await getRepository(User).findOneByOrFail({ id: person.id });
    assert.equal(moved.userType, UserType.EMBY);
    assert.equal(moved.embyUserId, PERSON_ID);
    const plexUser = await getRepository(User).findOneByOrFail({ id: 2 });
    assert.equal(plexUser.userType, UserType.PLEX);
    const stillLocal = await getRepository(User).findOneByOrFail({
      id: local.id,
    });
    assert.equal(stillLocal.userType, UserType.LOCAL);
  });

  it('moves nothing on a Jellyfin install', async () => {
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.JELLYFIN;
    const { film } = await seedEmbyInstall();
    await splitEmbyData();
    const same = await getRepository(Media).findOneByOrFail({ id: film.id });
    assert.equal(same.jellyfinMediaId, 'emby-603');
    assert.equal(same.embyMediaId, null);
  });
});

describe('an Emby install after the upgrade', () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );

  const upgraded = async () => {
    upgradeSettings();
    const seeded = await seedEmbyInstall();
    await splitEmbyData();
    return seeded;
  };

  it('signs people in with their Emby account', async () => {
    const { person } = await upgraded();
    const servers: string[] = [];
    const login = mock.method(
      JellyfinAPI.prototype,
      'login',
      async function (this: JellyfinAPI): Promise<JellyfinLoginResponse> {
        servers.push(this.kind);
        return {
          User: {
            Id: PERSON_ID,
            Name: 'person',
            ServerId: 'emby-server',
            Policy: { IsAdministrator: false },
          },
          AccessToken: 'new-token',
        } as unknown as JellyfinLoginResponse;
      }
    );
    const head = mock.method(axios, 'head', async () => {
      throw new Error('no picture');
    });
    try {
      const res = await request(app)
        .post('/auth/jellyfin')
        .send({ username: 'person', password: 'secret' });
      assert.equal(res.status, 200);
      assert.equal(res.body.id, person.id, 'the same person, not a new one');
      assert.deepEqual(servers, ['emby']);
      assert.equal(await getRepository(User).count(), 3);
      const after = await getRepository(User).findOneByOrFail({
        id: person.id,
      });
      assert.equal(after.avatar, `/avatarproxy/${PERSON_ID}?v=old`);
      assert.equal(after.userType, UserType.EMBY);
    } finally {
      login.mock.restore();
      head.mock.restore();
    }
  });

  it('asks Emby whether an account may still sign in', async () => {
    const { person } = await upgraded();
    const asked: string[] = [];
    const getAccount = mock.method(
      JellyfinAPI.prototype,
      'getAccount',
      async function (this: JellyfinAPI, id: string) {
        asked.push(`${this.kind}:${id}`);
        return { Id: id, Name: 'person', Policy: { IsDisabled: false } };
      }
    );
    try {
      const user = await getRepository(User).findOneByOrFail({
        id: person.id,
      });
      assert.equal(await maySignIn(user, 'passkey'), true);
      assert.deepEqual(asked, [`emby:${PERSON_ID}`]);
    } finally {
      getAccount.mock.restore();
    }
  });

  it('does not offer Quick Connect, which is Jellyfin only', async () => {
    await upgraded();
    const res = await request(app).post('/auth/jellyfin/quickconnect/initiate');
    assert.equal(res.status, 403);
  });

  it("scans Emby's libraries into Emby's columns", async () => {
    await upgraded();
    mock.method(animeList, 'sync', async () => undefined);
    const libraries: string[] = [];
    const contents = mock.method(
      JellyfinAPI.prototype,
      'getLibraryContents',
      async function (this: JellyfinAPI, id: string) {
        libraries.push(`${this.kind}:${id}`);
        return [
          { Id: 'emby-550', Name: 'Fight Club', Type: 'Movie' },
        ] as JellyfinLibraryItem[];
      }
    );
    const itemData = mock.method(
      JellyfinAPI.prototype,
      'getItemData',
      async () => ({
        Id: 'emby-550',
        Name: 'Fight Club',
        Type: 'Movie',
        ProviderIds: { Tmdb: '550' },
      })
    );
    try {
      await jellyfinFullScanner.run();
      assert.deepEqual(libraries, [], 'Jellyfin is not connected');

      await embyFullScanner.run();
      assert.deepEqual(libraries, ['emby:films']);
      const film = await getRepository(Media).findOneByOrFail({
        tmdbId: 550,
        mediaType: MediaType.MOVIE,
      });
      assert.equal(film.embyMediaId, 'emby-550');
      assert.equal(film.jellyfinMediaId, null);
      assert.equal(film.status, MediaStatus.AVAILABLE);
    } finally {
      contents.mock.restore();
      itemData.mock.restore();
    }
  });

  it("links titles to Emby's item page and finds avatars on Emby", async () => {
    const { film, person } = await upgraded();
    const media = await getRepository(Media).findOneByOrFail({ id: film.id });
    assert.equal(
      media.mediaUrl,
      'https://emby.example.com/web/index.html#!/item?id=emby-603&context=home&serverId=emby-server'
    );
    assert.deepEqual(
      media.playLinks?.map((link) => link.server),
      ['emby']
    );

    const head = mock.method(axios, 'head', async () => ({
      status: 200,
      headers: { etag: '"old"' },
    }));
    try {
      const user = await getRepository(User).findOneByOrFail({
        id: person.id,
      });
      await checkAvatarChanged(user);
      assert.equal(
        head.mock.calls[0].arguments[0],
        `http://emby.lan:8096/Users/${PERSON_ID}/Images/Primary?quality=90`
      );
    } finally {
      head.mock.restore();
    }
  });
});

describe('setting up a new server', () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use(checkUser);
  app.use('/auth', authRoutes);

  // Setup starts the scheduled jobs; they are stopped when the tests end.
  after(() => schedule.gracefulShutdown());

  const setUp = async (serverType: MediaServerType) => {
    const kinds: string[] = [];
    const login = mock.method(
      JellyfinAPI.prototype,
      'login',
      async function (this: JellyfinAPI) {
        kinds.push(this.kind);
        return {
          User: {
            Id: 'new-owner-id',
            Name: 'owner',
            ServerId: 'new-server',
            Policy: { IsAdministrator: true },
          },
          AccessToken: 'owner-token',
        } as unknown as JellyfinLoginResponse;
      }
    );
    const token = mock.method(
      JellyfinAPI.prototype,
      'createApiToken',
      async () => 'new-api-key'
    );
    const name = mock.method(
      JellyfinAPI.prototype,
      'getServerName',
      async () => 'New Server'
    );
    const head = mock.method(axios, 'head', async () => {
      throw new Error('no picture');
    });
    try {
      const res = await request(app).post('/auth/jellyfin').send({
        username: 'owner',
        password: 'secret',
        hostname: 'media.lan',
        port: 8096,
        useSsl: false,
        urlBase: '',
        email: 'owner@example.com',
        serverType,
      });
      return { res, kinds };
    } finally {
      login.mock.restore();
      token.mock.restore();
      name.mock.restore();
      head.mock.restore();
    }
  };

  it("keeps an Emby server's settings and the owner's account as Emby's", async () => {
    const { res, kinds } = await setUp(MediaServerType.EMBY);
    assert.equal(res.status, 200);
    assert.deepEqual(kinds, ['emby']);
    const settings = getSettings();
    assert.equal(settings.main.mediaServerType, MediaServerType.EMBY);
    assert.equal(settings.emby.connected, true);
    assert.equal(settings.emby.apiKey, 'new-api-key');
    assert.equal(settings.emby.ip, 'media.lan');
    assert.equal(settings.emby.name, 'New Server');
    assert.equal(settings.jellyfin.apiKey, '');
    assert.equal(settings.jellyfin.connected, false);

    const owner = await getRepository(User).findOneByOrFail({ id: 1 });
    assert.equal(owner.embyUserId, 'new-owner-id');
    assert.equal(owner.embyUsername, 'owner');
    assert.equal(owner.jellyfinUserId, null);
    assert.equal(owner.userType, UserType.EMBY);
  });

  it("keeps a Jellyfin server's in Jellyfin's, as before", async () => {
    const { res, kinds } = await setUp(MediaServerType.JELLYFIN);
    assert.equal(res.status, 200);
    assert.deepEqual(kinds, ['jellyfin']);
    const settings = getSettings();
    assert.equal(settings.main.mediaServerType, MediaServerType.JELLYFIN);
    assert.equal(settings.jellyfin.connected, true);
    assert.equal(settings.jellyfin.apiKey, 'new-api-key');
    assert.equal(settings.emby.apiKey, '');
    const owner = await getRepository(User).findOneByOrFail({ id: 1 });
    assert.equal(owner.jellyfinUserId, 'new-owner-id');
    assert.equal(owner.embyUserId, null);
    assert.equal(owner.userType, UserType.JELLYFIN);
  });
});
