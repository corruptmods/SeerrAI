import assert from 'node:assert/strict';
import { afterEach, before, describe, it, mock } from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import type { MediaServerKind } from '@server/constants/server';
import {
  MEDIA_SERVER_KINDS,
  MediaServerType,
  typeOfKind,
} from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import userRoutes from '.';

// Everyone signing in here with a password is on the owner's Plex share
// list.
mock.method(PlexTvAPI.prototype, 'checkUserAccess', async () => true);

let app: Express;

before(() => {
  app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/user', isAuthenticated(), userRoutes);
  app.use('/settings', isAuthenticated(Permission.ADMIN), settingsRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // Express knows an error handler by its four parameters.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );
});

setupTestDb();

const loginAs = async (email: string, password = 'test1234') => {
  getSettings().main.localLogin = true;
  const agent = request.agent(app);
  const res = await agent.post('/auth/local').send({ email, password });
  assert.equal(res.status, 200);
  return { agent, id: res.body.id as number };
};

const permissionsOf = async (id: number) =>
  (await getRepository(User).findOneByOrFail({ id })).permissions;

/*
 * The seeded friend becomes someone who manages users without being an
 * admin; beside them, a second admin and an ordinary user.
 */
const people = async () => {
  const users = getRepository(User);
  const manager = await users.findOneByOrFail({ email: 'friend@seerr.dev' });
  await users.update(manager.id, { permissions: Permission.MANAGE_USERS });
  const admin = await users.save(
    new User({
      email: 'second-admin@seerr.dev',
      username: 'second',
      avatar: '',
      permissions: Permission.ADMIN,
      userType: UserType.LOCAL,
    })
  );
  const regular = await users.save(
    new User({
      email: 'regular@seerr.dev',
      username: 'regular',
      avatar: '',
      permissions: Permission.REQUEST,
      userType: UserType.LOCAL,
    })
  );
  return { manager, admin, regular };
};

describe('changing permissions from the user list', () => {
  it('never lets someone raise their own', async () => {
    const { manager } = await people();
    const { agent } = await loginAs('friend@seerr.dev');
    const raised = Permission.MANAGE_USERS | Permission.MANAGE_SETTINGS;

    const one = await agent
      .put(`/user/${manager.id}`)
      .send({ permissions: raised });
    assert.equal(one.status, 403);

    const bulk = await agent
      .put('/user')
      .send({ ids: [String(manager.id)], permissions: raised });
    assert.equal(bulk.status, 200);
    assert.equal(await permissionsOf(manager.id), Permission.MANAGE_USERS);
  });

  it('never lets a user manager demote an admin', async () => {
    const { admin, regular } = await people();
    const { agent } = await loginAs('friend@seerr.dev');

    const one = await agent
      .put(`/user/${admin.id}`)
      .send({ permissions: Permission.REQUEST });
    assert.equal(one.status, 403);

    const bulk = await agent.put('/user').send({
      ids: [String(admin.id), String(regular.id), '1'],
      permissions: Permission.AUTO_APPROVE,
    });
    assert.equal(bulk.status, 200);
    assert.equal(await permissionsOf(admin.id), Permission.ADMIN);
    assert.equal(await permissionsOf(1), Permission.ADMIN);
    // Everyone else chosen is changed as before.
    assert.equal(await permissionsOf(regular.id), Permission.AUTO_APPROVE);
    assert.deepEqual(
      (bulk.body as { id: number }[]).map((user) => user.id),
      [regular.id]
    );
  });

  it('lets the owner change an admin, but never their own', async () => {
    const { admin } = await people();
    const { agent } = await loginAs('admin@seerr.dev');

    const one = await agent
      .put(`/user/${admin.id}`)
      .send({ username: 'renamed', permissions: Permission.MANAGE_USERS });
    assert.equal(one.status, 200);
    assert.equal(await permissionsOf(admin.id), Permission.MANAGE_USERS);

    const bulk = await agent
      .put('/user')
      .send({ ids: ['1', String(admin.id)], permissions: Permission.REQUEST });
    assert.equal(bulk.status, 200);
    assert.equal(await permissionsOf(admin.id), Permission.REQUEST);
    assert.equal(await permissionsOf(1), Permission.ADMIN);
  });

  it('answers without anyone’s email or settings', async () => {
    const { regular } = await people();
    const { agent } = await loginAs('admin@seerr.dev');

    const bulk = await agent
      .put('/user')
      .send({ ids: [String(regular.id)], permissions: Permission.REQUEST });
    assert.equal(bulk.status, 200);
    const [changed] = bulk.body as Record<string, unknown>[];
    assert.equal(changed.permissions, Permission.REQUEST);
    assert.equal(changed.email, undefined);
    assert.equal(changed.settings, undefined);
  });
});

describe('registering for push notifications', () => {
  const register = async (endpoint: unknown) => {
    const { agent } = await loginAs('friend@seerr.dev');
    return agent.post('/user/registerPushSubscription').send({
      endpoint,
      p256dh: 'p256dh-key',
      auth: `auth-${String(endpoint)}`,
      userAgent: 'test',
    });
  };

  it('accepts the browsers’ push services', async () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      assert.equal((await register(endpoint)).status, 204, endpoint);
    }
  });

  it('refuses any other address', async () => {
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://127.0.0.1/abc',
      'https://localhost:8080/abc',
      'https://192.168.1.10/abc',
      'https://router.lan/abc',
      'https://fcm.googleapis.com.evil.test/abc',
      'https://fcm.googleapis.com:8443/abc',
      'not a url',
      42,
    ]) {
      assert.equal((await register(endpoint)).status, 400, String(endpoint));
    }
    assert.equal(await getRepository(UserPushSubscription).count(), 0);
  });
});

describe('importing Plex users', () => {
  it('leaves a password account with a Plex friend’s email alone', async () => {
    getSettings().main.mediaServerType = MediaServerType.PLEX;
    const users = getRepository(User);
    const local = new User({
      email: 'taken@seerr.dev',
      username: 'local',
      avatar: '',
      permissions: Permission.REQUEST,
      userType: UserType.LOCAL,
    });
    await local.setPassword('test1234');
    await users.save(local);

    const getUsers = mock.method(PlexTvAPI.prototype, 'getUsers', async () => ({
      MediaContainer: {
        User: [
          {
            $: {
              id: '9001',
              title: 'friend',
              username: 'plexfriend',
              email: 'taken@seerr.dev',
              thumb: 'https://plex.tv/thumb',
            },
            Server: [],
          },
        ],
      },
    }));
    try {
      const { agent } = await loginAs('admin@seerr.dev');
      const res = await agent.post('/user/import-from-plex').send();
      assert.equal(res.status, 201);
      assert.equal(res.body.refreshedUsers, 0);
      assert.deepEqual(res.body.skippedUsers, [
        { id: '9001', name: 'plexfriend', reason: 'EXISTING_ACCOUNT' },
      ]);
    } finally {
      getUsers.mock.restore();
    }

    const after = await users.findOneByOrFail({ id: local.id });
    assert.equal(after.userType, UserType.LOCAL);
    assert.equal(after.plexId, null);
    assert.equal(after.plexUsername, null);
  });
});

describe('importing Jellyfin users', () => {
  // Two people on the Jellyfin server: one already brought in (stored the
  // way older imports and Emby kept ids, with dashes and capitals) who has
  // since been renamed there, and one who is new.
  const known = '0123456789abcdef0123456789abcdef';
  const fresh = 'fedcba9876543210fedcba9876543210';

  const withJellyfin = async (run: () => Promise<void>) => {
    const main = getSettings().main;
    const saved = main.mediaServerType;
    main.mediaServerType = MediaServerType.JELLYFIN;
    const getUsers = mock.method(
      JellyfinAPI.prototype,
      'getUsers',
      async () => ({
        users: [
          { Id: known, Name: 'Renamed On Jellyfin' },
          { Id: fresh, Name: 'Newcomer' },
        ],
      })
    );
    // Avatars are looked up on the Jellyfin server; there is none here.
    const head = mock.method(axios, 'head', async () => {
      throw new Error('no Jellyfin server in tests');
    });
    try {
      await getRepository(User).save(
        new User({
          email: 'old-name',
          jellyfinUsername: 'Old Name',
          jellyfinUserId: '01234567-89AB-CDEF-0123-456789ABCDEF',
          avatar: '',
          permissions: Permission.REQUEST,
          userType: UserType.JELLYFIN,
        })
      );
      await run();
    } finally {
      getUsers.mock.restore();
      head.mock.restore();
      main.mediaServerType = saved;
    }
  };

  it('refreshes people already imported and creates only those chosen', () =>
    withJellyfin(async () => {
      const { agent } = await loginAs('admin@seerr.dev');
      const res = await agent
        .post('/user/import-from-jellyfin')
        .send({ jellyfinUserIds: [fresh] });

      assert.equal(res.status, 201);
      assert.equal(res.body.refreshedUsers, 1);
      assert.deepEqual(
        res.body.createdUsers.map((u: User) => u.jellyfinUsername),
        ['Newcomer']
      );

      const users = getRepository(User);
      const kept = await users.find({ where: { userType: UserType.JELLYFIN } });
      assert.equal(kept.length, 2, 'the imported person was not duplicated');
      const refreshed = kept.find((u) => u.email === 'old-name');
      assert.equal(refreshed?.jellyfinUsername, 'Renamed On Jellyfin');
      // The account itself is left as it was: only what comes from Jellyfin
      // is brought up to date.
      assert.equal(refreshed?.permissions, Permission.REQUEST);
    }));

  it('refreshes without creating anyone when nobody is chosen', () =>
    withJellyfin(async () => {
      const { agent } = await loginAs('admin@seerr.dev');
      const res = await agent
        .post('/user/import-from-jellyfin')
        .send({ jellyfinUserIds: [] });

      assert.equal(res.status, 201);
      assert.equal(res.body.refreshedUsers, 1);
      assert.deepEqual(res.body.createdUsers, []);
    }));

  it('offers only the people not yet imported', () =>
    withJellyfin(async () => {
      const { agent } = await loginAs('admin@seerr.dev');
      const res = await agent.get('/settings/jellyfin/users');

      assert.equal(res.status, 200);
      assert.deepEqual(
        res.body.map((u: { id: string }) => u.id),
        [fresh]
      );
    }));
});

describe('watchlist sync for new people', () => {
  const syncOf = async (where: { email?: string; jellyfinUserId?: string }) => {
    const user = await getRepository(User).findOneOrFail({ where });
    return [
      !!user.settings?.watchlistSyncMovies,
      !!user.settings?.watchlistSyncTv,
    ];
  };

  const withDefaults = async (
    movies: boolean,
    tv: boolean,
    run: () => Promise<void>
  ) => {
    const main = getSettings().main;
    main.defaultWatchlistSyncMovies = movies;
    main.defaultWatchlistSyncTv = tv;
    try {
      await run();
    } finally {
      main.defaultWatchlistSyncMovies = false;
      main.defaultWatchlistSyncTv = false;
    }
  };

  it('starts someone an admin creates as admins chose', () =>
    withDefaults(true, false, async () => {
      const { agent } = await loginAs('admin@seerr.dev');
      const res = await agent.post('/user').send({
        email: 'made@seerr.dev',
        username: 'made',
        password: 'test1234',
      });
      assert.equal(res.status, 201);
      assert.deepEqual(await syncOf({ email: 'made@seerr.dev' }), [
        true,
        false,
      ]);
    }));

  it('leaves it off, as before, unless admins chose otherwise', async () => {
    const { agent } = await loginAs('admin@seerr.dev');
    const res = await agent.post('/user').send({
      email: 'plain@seerr.dev',
      username: 'plain',
      password: 'test1234',
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await syncOf({ email: 'plain@seerr.dev' }), [
      false,
      false,
    ]);
  });

  it('starts people imported from Plex as admins chose, and leaves others be', () =>
    withDefaults(false, true, async () => {
      getSettings().main.mediaServerType = MediaServerType.PLEX;
      const users = getRepository(User);
      // The seeded friend shares the owner's Plex id; give them their own,
      // so the import refreshes them as someone already here.
      const friend = await users.findOneByOrFail({ email: 'friend@seerr.dev' });
      await users.update(friend.id, { plexId: 9200 });
      const getUsers = mock.method(
        PlexTvAPI.prototype,
        'getUsers',
        async () => ({
          MediaContainer: {
            User: [
              {
                $: {
                  id: '9100',
                  title: 'new',
                  username: 'newplex',
                  email: 'newplex@seerr.dev',
                  thumb: 'https://plex.tv/thumb',
                },
                Server: [],
              },
              {
                $: {
                  id: '9200',
                  title: 'friend',
                  username: 'friend',
                  email: 'friend@seerr.dev',
                  thumb: 'https://plex.tv/thumb',
                },
                Server: [],
              },
            ],
          },
        })
      );
      try {
        const { agent } = await loginAs('admin@seerr.dev');
        const res = await agent.post('/user/import-from-plex').send();
        assert.equal(res.status, 201);
      } finally {
        getUsers.mock.restore();
      }
      assert.deepEqual(await syncOf({ email: 'newplex@seerr.dev' }), [
        false,
        true,
      ]);
      assert.deepEqual(await syncOf({ email: 'friend@seerr.dev' }), [
        false,
        false,
      ]);
    }));

  it('starts people imported from Jellyfin as admins chose', () =>
    withDefaults(true, true, async () => {
      const id = 'abcdefabcdefabcdefabcdefabcdef12';
      const main = getSettings().main;
      const saved = main.mediaServerType;
      main.mediaServerType = MediaServerType.JELLYFIN;
      const getUsers = mock.method(
        JellyfinAPI.prototype,
        'getUsers',
        async () => ({
          users: [{ Id: id, Name: 'Jelly' }],
        })
      );
      try {
        const { agent } = await loginAs('admin@seerr.dev');
        const res = await agent
          .post('/user/import-from-jellyfin')
          .send({ jellyfinUserIds: [id] });
        assert.equal(res.status, 201);
      } finally {
        getUsers.mock.restore();
        main.mediaServerType = saved;
      }
      assert.deepEqual(await syncOf({ jellyfinUserId: id }), [true, true]);
    }));
});

describe('a name to show for someone', () => {
  it('is never their email', async () => {
    const users = getRepository(User);
    const nameless = await users.save(
      new User({
        email: 'nameless@seerr.dev',
        avatar: '',
        permissions: Permission.REQUEST,
        userType: UserType.LOCAL,
      })
    );
    const { agent } = await loginAs('friend@seerr.dev');

    const res = await agent.get(`/user/${nameless.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.displayName, `User #${nameless.id}`);
    assert.doesNotMatch(JSON.stringify(res.body), /nameless@seerr\.dev/);
  });
});

describe('people on several media servers', () => {
  const connectServers = (...kinds: MediaServerKind[]) => {
    const settings = getSettings();
    settings.main.mediaServerType = typeOfKind(kinds[0]);
    for (const kind of MEDIA_SERVER_KINDS) {
      settings[kind].connected = kinds.includes(kind);
    }
  };
  afterEach(() => {
    for (const kind of MEDIA_SERVER_KINDS) {
      getSettings()[kind].connected = false;
    }
  });

  it('imports from Emby beside Jellyfin, leaving out names already taken', async () => {
    connectServers('jellyfin', 'emby');
    const users = getRepository(User);
    const jellyfinBob = await users.save(
      new User({
        email: 'bob',
        jellyfinUsername: 'bob',
        jellyfinUserId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        avatar: '',
        permissions: Permission.REQUEST,
        userType: UserType.JELLYFIN,
      })
    );
    const asked: string[] = [];
    const getUsers = mock.method(
      JellyfinAPI.prototype,
      'getUsers',
      async function (this: JellyfinAPI) {
        asked.push(this.kind);
        return {
          users: [
            { Id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', Name: 'bob' },
            { Id: 'cccccccccccccccccccccccccccccccc', Name: 'carol' },
          ],
        };
      }
    );
    try {
      const { agent } = await loginAs('admin@seerr.dev');
      const res = await agent.post('/user/import-from-emby').send({});

      assert.equal(res.status, 201);
      assert.deepEqual(asked, ['emby']);
      assert.deepEqual(
        res.body.createdUsers.map((u: User) => u.embyUsername),
        ['carol']
      );
      assert.deepEqual(res.body.skippedUsers, [
        {
          id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          name: 'bob',
          reason: 'EXISTING_ACCOUNT',
        },
      ]);
    } finally {
      getUsers.mock.restore();
    }

    const carol = await users.findOneByOrFail({ email: 'carol' });
    assert.equal(carol.userType, UserType.EMBY);
    assert.equal(carol.embyUserId, 'cccccccccccccccccccccccccccccccc');
    assert.equal(carol.jellyfinUserId, null);
    const bob = await users.findOneByOrFail({ id: jellyfinBob.id });
    assert.equal(bob.embyUserId, null, 'never merged');
  });

  it('imports only from servers Seerr is connected to', async () => {
    connectServers('jellyfin');
    const getUsers = mock.method(PlexTvAPI.prototype, 'getUsers', async () => ({
      MediaContainer: { User: [] },
    }));
    try {
      const { agent } = await loginAs('admin@seerr.dev');
      assert.equal(
        (await agent.post('/user/import-from-emby').send({})).status,
        400
      );
      assert.equal(
        (await agent.post('/user/import-from-plex').send()).status,
        400
      );
      assert.equal(getUsers.mock.callCount(), 0);
    } finally {
      getUsers.mock.restore();
    }
  });

  it('finds and sorts people by their Emby name', async () => {
    const users = getRepository(User);
    await users.save(
      new User({
        email: 'zed-email',
        embyUsername: 'Aardvark',
        embyUserId: 'emby-aardvark',
        avatar: '',
        permissions: Permission.REQUEST,
        userType: UserType.EMBY,
      })
    );
    const { agent } = await loginAs('admin@seerr.dev');

    const found = await agent.get('/user').query({ q: 'aardv' });
    assert.equal(found.status, 200);
    assert.deepEqual(
      found.body.results.map((u: User) => u.displayName),
      ['Aardvark']
    );

    const sorted = await agent.get('/user').query({ sort: 'displayname' });
    assert.equal(sorted.body.results[0].displayName, 'Aardvark');
    assert.deepEqual(sorted.body.results[0].linkedServers, ['emby']);
  });
});
