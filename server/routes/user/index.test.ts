import assert from 'node:assert/strict';
import { afterEach, before, describe, it, mock } from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import { MediaType } from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import {
  MEDIA_SERVER_KINDS,
  MediaServerType,
  typeOfKind,
} from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { Watchlist } from '@server/entity/Watchlist';
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

// Every password sign-in here is on the owner's Plex share list.
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
      // Express detects an error handler by its four parameters.
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
 * Makes the seeded friend a non-admin user manager, and adds a second admin
 * and an ordinary user.
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
    // The other selected users are still changed.
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

describe("someone else's push devices", () => {
  const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/harbour-lights';

  const deviceFor = (user: User) =>
    getRepository(UserPushSubscription).save(
      new UserPushSubscription({
        user,
        endpoint: ENDPOINT,
        p256dh: 'p256dh-key',
        auth: 'auth-key',
        userAgent: 'test',
      })
    );

  it("stay the owner's and admins' own, even from user managers", async () => {
    const { admin, regular } = await people();
    const users = getRepository(User);
    await deviceFor(await users.findOneByOrFail({ id: 1 }));
    const { agent } = await loginAs('friend@seerr.dev');

    for (const id of [1, admin.id]) {
      assert.equal(
        (await agent.get(`/user/${id}/pushSubscriptions`)).status,
        403
      );
      const path = `/user/${id}/pushSubscription/${encodeURIComponent(ENDPOINT)}`;
      assert.equal((await agent.get(path)).status, 403);
      assert.equal((await agent.delete(path)).status, 403);
    }
    assert.equal(await getRepository(UserPushSubscription).count(), 1);

    // An ordinary user's are still theirs to manage.
    await getRepository(UserPushSubscription).clear();
    await deviceFor(regular);
    const listed = await agent.get(`/user/${regular.id}/pushSubscriptions`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
  });

  it('are seen by the owner, and by each person for themselves', async () => {
    const { admin } = await people();
    await deviceFor(admin);
    const owner = await loginAs('admin@seerr.dev');
    assert.equal(
      (await owner.agent.get(`/user/${admin.id}/pushSubscriptions`)).body
        .length,
      1
    );
    const own = await loginAs('friend@seerr.dev');
    assert.equal(
      (await own.agent.get(`/user/${own.id}/pushSubscriptions`)).status,
      200
    );
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

  it('brings email and picture from Plex only as signing in with Plex does', async () => {
    getSettings().main.mediaServerType = MediaServerType.PLEX;
    const users = getRepository(User);
    // Signs in with Jellyfin and has Plex linked.
    const jellyfinMain = await users.save(
      new User({
        email: 'jelly@seerr.dev',
        username: 'jelly',
        avatar: '/avatarproxy/jf',
        permissions: Permission.REQUEST,
        userType: UserType.JELLYFIN,
        jellyfinUserId: 'jf-jelly',
        plexId: 9301,
      })
    );
    // A Plex account whose Plex email belongs to another user here.
    const plexMain = await users.save(
      new User({
        email: 'plexmain@seerr.dev',
        avatar: 'https://plex.tv/old',
        permissions: Permission.REQUEST,
        userType: UserType.PLEX,
        plexId: 9302,
      })
    );
    const plexUser = (id: string, username: string, email: string) => ({
      $: {
        id,
        title: username,
        username,
        email,
        thumb: `https://plex.tv/${username}`,
      },
      Server: [],
    });
    const getUsers = mock.method(PlexTvAPI.prototype, 'getUsers', async () => ({
      MediaContainer: {
        User: [
          plexUser('9301', 'jellyonplex', 'jelly-plex@seerr.dev'),
          plexUser('9302', 'plexmain', 'friend@seerr.dev'),
          plexUser('9303', 'newcomer', 'newcomer@seerr.dev'),
        ],
      },
    }));
    try {
      const { agent } = await loginAs('admin@seerr.dev');
      const res = await agent.post('/user/import-from-plex').send();
      assert.equal(res.status, 201, res.text);
      assert.equal(res.body.refreshedUsers, 2);
      assert.deepEqual(
        res.body.createdUsers.map((u: User) => u.plexUsername),
        ['newcomer']
      );
    } finally {
      getUsers.mock.restore();
    }

    // Their Jellyfin email (used to sign in) and avatar are kept.
    const jelly = await users.findOneByOrFail({ id: jellyfinMain.id });
    assert.equal(jelly.email, 'jelly@seerr.dev');
    assert.equal(jelly.avatar, '/avatarproxy/jf');
    assert.equal(jelly.plexUsername, 'jellyonplex');
    // A new avatar, but never another account's email.
    const plex = await users.findOneByOrFail({ id: plexMain.id });
    assert.equal(plex.email, 'plexmain@seerr.dev');
    assert.equal(plex.avatar, 'https://plex.tv/plexmain');
  });

  it('ties an account waiting for its Plex account to it', async () => {
    getSettings().main.mediaServerType = MediaServerType.PLEX;
    const users = getRepository(User);
    // Created by an admin for a Plex friend who has never signed in.
    const waiting = await users.save(
      new User({
        email: 'waiting@seerr.dev',
        avatar: '',
        permissions: Permission.REQUEST,
        userType: UserType.PLEX,
      })
    );
    const getUsers = mock.method(PlexTvAPI.prototype, 'getUsers', async () => ({
      MediaContainer: {
        User: [
          {
            $: {
              id: '9401',
              title: 'waiting',
              username: 'waitingonplex',
              email: 'waiting@seerr.dev',
              thumb: 'https://plex.tv/waiting',
            },
            Server: [],
          },
        ],
      },
    }));
    try {
      const { agent } = await loginAs('admin@seerr.dev');
      const res = await agent.post('/user/import-from-plex').send();
      assert.equal(res.status, 201, res.text);
      assert.equal(res.body.refreshedUsers, 1);
      assert.deepEqual(res.body.createdUsers, []);
    } finally {
      getUsers.mock.restore();
    }

    // Now matched by Plex account, as a sign-in would leave it.
    const after = await users.findOneByOrFail({ id: waiting.id });
    assert.equal(after.plexId, 9401);
    assert.equal(after.plexUsername, 'waitingonplex');
  });
});

describe('importing Jellyfin users', () => {
  // Two Jellyfin users: one already imported (id stored with dashes and
  // capitals, as older imports and Emby did) and since renamed, and one new.
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
    // Avatars come from the Jellyfin server, which tests don't have.
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
      // Only Jellyfin-sourced fields are refreshed; the account is unchanged.
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
      // The seeded friend shares the owner's Plex id; give them their own so
      // the import refreshes them as an existing user.
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

describe('sorting people by name', () => {
  it('orders someone without a name by the name shown, not their email', async () => {
    const users = getRepository(User);
    const nameless = await users.save(
      new User({
        email: 'aaaa@example.invalid',
        avatar: '',
        permissions: Permission.REQUEST,
        userType: UserType.LOCAL,
      })
    );
    const { agent, id } = await loginAs('friend@seerr.dev');
    const order = async () =>
      (
        await agent
          .get('/user')
          .query({ sort: 'displayname', includeIds: `${id},${nameless.id}` })
      ).body.results.map((u: User) => u.id);

    // "Static Garden" sorts before "User #n", whatever the hidden email.
    await users.update(id, { username: 'Static Garden' });
    const before = await order();
    assert.deepEqual(before, [id, nameless.id]);
    await users.update(nameless.id, { email: 'zzzz@example.invalid' });
    assert.deepEqual(await order(), before);
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

describe("the order of someone's watchlist", () => {
  it('lists it newest added first, or by title, when asked', async () => {
    const { agent, id } = await loginAs('admin@seerr.dev');
    const owner = await getRepository(User).findOneByOrFail({ id });
    for (const [tmdbId, title] of [
      [9201, 'Static Garden'],
      [9202, 'The Harbour Lights'],
      [9203, 'Lantern Song'],
    ] as const) {
      const media = await getRepository(Media).save(
        new Media({ tmdbId, mediaType: MediaType.MOVIE })
      );
      await getRepository(Watchlist).save(
        Object.assign(new Watchlist(), {
          tmdbId,
          mediaType: MediaType.MOVIE,
          title,
          requestedBy: owner,
          media,
        })
      );
    }
    const order = async (query: string) => {
      const res = await agent.get(`/user/${id}/watchlist${query}`);
      assert.equal(res.status, 200);
      return (res.body.results as { tmdbId: number }[]).map((i) => i.tmdbId);
    };

    assert.deepEqual(await order(''), [9201, 9202, 9203]);
    assert.deepEqual(await order('?sort=added-desc'), [9203, 9202, 9201]);
    assert.deepEqual(await order('?sort=title'), [9202, 9203, 9201]);
  });
});
