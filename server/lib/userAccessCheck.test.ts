import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import TheMovieDb from '@server/api/themoviedb';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import plexUserImport from '@server/lib/plexUserImport';
import { getSettings } from '@server/lib/settings';
import userAccessCheck from '@server/lib/userAccessCheck';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import { AxiosError, AxiosHeaders } from 'axios';
import express from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';

/*
 * Accounts of people the media server no longer has are removed, carefully;
 * and deleting a user can take them off the media server too.
 */

const MACHINE = 'this-server';
const JELLYFIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Plex's shared-user list: id, whether this server is shared, Plex Home. */
let plexShared: { id: string; access: boolean; home?: boolean }[] = [];
let plexFails = false;
/** The seeded friend's Plex account, shared unless a test says otherwise. */
let friendPlexId = '';
let friendShared = true;
let jellyfinAccounts: { Id: string; Name: string }[] = [];

setupTestDb();

// A new request's notification names the title.
Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async ({ movieId }: { movieId: number }) => ({
      id: movieId,
      title: 'Glasswing',
      overview: '',
      release_date: '2026-01-01',
    });
  },
});

const plexReply = () => ({
  MediaContainer: {
    User: [
      ...(friendShared ? [{ id: friendPlexId, access: true }] : []),
      ...plexShared,
    ].map((user: { id: string; access: boolean; home?: boolean }) => ({
      $: {
        id: user.id,
        title: `user${user.id}`,
        username: `user${user.id}`,
        email: `user${user.id}@example.invalid`,
        thumb: '',
        ...(user.home && { home: '1' }),
      },
      Server: user.access
        ? [{ $: { machineIdentifier: MACHINE } }]
        : [{ $: { machineIdentifier: 'someone-elses' } }],
    })),
  },
});

const failure = (status: number) =>
  new AxiosError('failed', String(status), undefined, undefined, {
    status,
    statusText: '',
    data: {},
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

beforeEach(async () => {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.plex.connected = true;
  settings.jellyfin.connected = false;
  settings.emby.connected = false;
  settings.plex.machineId = MACHINE;
  settings.main.removeUsersWithoutAccess = true;
  settings.main.autoImportPlexUsers = false;
  settings.main.localLogin = true;
  await getRepository(User).update({ id: 1 }, { plexToken: 'owner-token' });

  plexShared = [];
  plexFails = false;
  friendShared = true;
  friendPlexId = String(
    (
      await getRepository(User).findOneOrFail({
        where: { email: 'friend@seerr.dev' },
      })
    ).plexId
  );
  jellyfinAccounts = [{ Id: 'jellyfin-admin', Name: 'admin' }];
  mock.method(PlexTvAPI.prototype, 'getUsers', async () => {
    if (plexFails) throw failure(503);
    return plexReply();
  });
  mock.method(JellyfinAPI.prototype, 'getAccounts', async () => [
    ...jellyfinAccounts,
  ]);
  // Two checks in a row: start each test from none.
  getSettings().main.removeUsersWithoutAccess = false;
  await userAccessCheck.run();
  getSettings().main.removeUsersWithoutAccess = true;
});

afterEach(() => {
  mock.restoreAll();
});

const plexPerson = (plexId: number, permissions = Permission.REQUEST) =>
  getRepository(User).save(
    new User({
      email: `user${plexId}@example.invalid`,
      plexUsername: `user${plexId}`,
      plexId,
      plexToken: '',
      userType: UserType.PLEX,
      permissions,
      avatar: '',
    })
  );

const exists = async (id: number) =>
  !!(await getRepository(User).findOne({ where: { id } }));

const requestFor = async (user: User, tmdbId: number) =>
  getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MOVIE,
      media: await getRepository(Media).save(
        new Media({ tmdbId, mediaType: MediaType.MOVIE })
      ),
      requestedBy: user,
      status: MediaRequestStatus.PENDING,
      is4k: false,
    })
  );

describe('User Access Check', () => {
  it('removes someone no longer shared, on the second check in a row', async () => {
    const kept = await plexPerson(601);
    const lost = await plexPerson(602);
    await requestFor(lost, 910001);
    plexShared = [
      { id: '601', access: true },
      { id: '602', access: false },
    ];

    assert.equal(await userAccessCheck.run(), 0);
    assert.ok(await exists(lost.id), 'kept after one check');

    assert.equal(await userAccessCheck.run(), 1);
    assert.equal(await exists(lost.id), false);
    assert.ok(await exists(kept.id));
    assert.equal(
      await getRepository(MediaRequest).count({
        where: { requestedBy: { id: lost.id } },
      }),
      0
    );
  });

  it('starts over when they come back between checks', async () => {
    const person = await plexPerson(603);
    plexShared = [{ id: '601', access: true }];
    await userAccessCheck.run();
    plexShared.push({ id: '603', access: true });
    await userAccessCheck.run();
    plexShared = [{ id: '601', access: true }];
    assert.equal(await userAccessCheck.run(), 0);
    assert.ok(await exists(person.id));
  });

  it('removes nobody when Plex cannot be read, or would lose everyone', async () => {
    const one = await plexPerson(604);
    const two = await plexPerson(605);
    plexShared = [{ id: '604', access: true }];
    await userAccessCheck.run();
    plexFails = true;
    assert.equal(await userAccessCheck.run(), 0);
    plexFails = false;
    // The failed check broke the run, so this is a first miss again.
    assert.equal(await userAccessCheck.run(), 0);
    assert.ok(await exists(two.id));

    plexShared = [];
    friendShared = false;
    await userAccessCheck.run();
    assert.equal(await userAccessCheck.run(), 0);
    assert.ok(await exists(one.id));
    assert.ok(await exists(two.id));
  });

  it('never removes the owner or an admin, and does nothing when off', async () => {
    const admin = await plexPerson(606, Permission.ADMIN);
    const person = await plexPerson(607);
    plexShared = [{ id: '608', access: true }];

    getSettings().main.removeUsersWithoutAccess = false;
    await userAccessCheck.run();
    await userAccessCheck.run();
    assert.ok(await exists(person.id));

    getSettings().main.removeUsersWithoutAccess = true;
    await userAccessCheck.run();
    assert.equal(await userAccessCheck.run(), 1);
    assert.ok(await exists(admin.id));
    assert.ok(await exists(1));
    assert.equal(await exists(person.id), false);
  });

  it('lets the Plex import bring them back once shared again', async () => {
    getSettings().main.autoImportPlexUsers = true;
    const person = await plexPerson(609);
    plexShared = [{ id: '610', access: true }];
    await userAccessCheck.run();
    await userAccessCheck.run();
    assert.equal(await exists(person.id), false);

    plexShared.push({ id: '609', access: true });
    assert.ok((await plexUserImport.run()).some((user) => user.plexId === 609));
  });

  it('removes someone deleted from Jellyfin', async () => {
    const settings = getSettings();
    settings.plex.connected = false;
    settings.main.mediaServerType = MediaServerType.JELLYFIN;
    settings.jellyfin.connected = true;
    settings.jellyfin.apiKey = 'key';
    const person = await getRepository(User).save(
      new User({
        email: 'jf@example.invalid',
        jellyfinUsername: 'jf',
        jellyfinUserId: JELLYFIN_ID.replace(/-/g, ''),
        userType: UserType.JELLYFIN,
        permissions: Permission.REQUEST,
        avatar: '',
      })
    );
    // Jellyfin lists ids with dashes; Seerr AI stores them without.
    jellyfinAccounts.push({ Id: JELLYFIN_ID, Name: 'jf' });
    await userAccessCheck.run();
    assert.equal(await userAccessCheck.run(), 0);

    jellyfinAccounts.pop();
    await userAccessCheck.run();
    assert.equal(await userAccessCheck.run(), 1);
    assert.equal(await exists(person.id), false);
  });
});

describe('deleting a user from their media server too', () => {
  const app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/user', isAuthenticated(), userRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // Express tells error handlers by their four arguments.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );

  const signedIn = async (email = 'admin@seerr.dev', password = 'test1234') => {
    const agent = request.agent(app);
    const signIn = await agent.post('/auth/local').send({ email, password });
    assert.equal(signIn.status, 200);
    return agent;
  };
  const deleteFromServer = async (id: number, agent?: request.Agent) =>
    (agent ?? (await signedIn())).delete(`/user/${id}?fromMediaServer=true`);

  it('ends the Plex friendship, then deletes and keeps them out', async () => {
    const unfriended = mock.method(
      PlexTvAPI.prototype,
      'removeFriend',
      async () => undefined
    );
    const person = await plexPerson(701);
    plexShared = [{ id: '701', access: true }];

    assert.equal((await deleteFromServer(person.id)).status, 200);
    assert.deepEqual(unfriended.mock.calls[0].arguments, [701]);
    assert.equal(await exists(person.id), false);

    getSettings().main.autoImportPlexUsers = true;
    assert.deepEqual(await plexUserImport.run(), []);
  });

  it('keeps the user when Plex refuses, or they are in Plex Home', async () => {
    const unfriended = mock.method(
      PlexTvAPI.prototype,
      'removeFriend',
      async () => {
        throw failure(500);
      }
    );
    const person = await plexPerson(702);
    const home = await plexPerson(703);
    plexShared = [
      { id: '702', access: true },
      { id: '703', access: true, home: true },
    ];

    assert.equal((await deleteFromServer(person.id)).status, 502);
    assert.ok(await exists(person.id));

    const refused = await deleteFromServer(home.id);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /Plex Home/);
    assert.ok(await exists(home.id));
    assert.equal(unfriended.mock.callCount(), 1);
  });

  it('is for admins only, though Manage Users can still delete', async () => {
    const unfriended = mock.method(
      PlexTvAPI.prototype,
      'removeFriend',
      async () => undefined
    );
    const manager = await getRepository(User).save(
      new User({
        email: 'manager@example.invalid',
        username: 'manager',
        userType: UserType.LOCAL,
        permissions: Permission.MANAGE_USERS,
        avatar: '',
      })
    );
    await manager.setPassword('manager-pass-1');
    await getRepository(User).save(manager);
    const person = await plexPerson(704);
    const agent = await signedIn('manager@example.invalid', 'manager-pass-1');

    assert.equal((await deleteFromServer(person.id, agent)).status, 403);
    assert.ok(await exists(person.id));
    assert.equal((await agent.delete(`/user/${person.id}`)).status, 200);
    assert.equal(unfriended.mock.callCount(), 0);
  });

  it('disables a Jellyfin account, keeping the rest of its policy', async () => {
    const settings = getSettings();
    settings.jellyfin.connected = true;
    settings.jellyfin.apiKey = 'key';
    const policy = {
      IsAdministrator: false,
      IsDisabled: false,
      EnableAllFolders: false,
      EnabledFolders: ['f1'],
    };
    let isAdmin = false;
    mock.method(JellyfinAPI.prototype, 'getPolicyAccount', async () => ({
      Id: JELLYFIN_ID,
      Name: 'jf',
      Policy: { ...policy, IsAdministrator: isAdmin },
    }));
    const set = mock.method(
      JellyfinAPI.prototype,
      'setPolicy',
      async () => undefined
    );
    const person = () =>
      getRepository(User).save(
        new User({
          email: `jf${Math.random()}@example.invalid`,
          jellyfinUsername: 'jf',
          jellyfinUserId: JELLYFIN_ID.replace(/-/g, ''),
          userType: UserType.JELLYFIN,
          permissions: Permission.REQUEST,
          avatar: '',
        })
      );

    const one = await person();
    assert.equal((await deleteFromServer(one.id)).status, 200);
    assert.deepEqual(set.mock.calls[0].arguments, [
      JELLYFIN_ID,
      { ...policy, IsDisabled: true },
    ]);

    isAdmin = true;
    const two = await person();
    assert.equal((await deleteFromServer(two.id)).status, 409);
    assert.ok(await exists(two.id));
    assert.equal(set.mock.callCount(), 1);
  });
});
