import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import type { MediaServerKind } from '@server/constants/server';
import { MEDIA_SERVER_KINDS, typeOfKind } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import OidcLink from '@server/entity/OidcLink';
import { Session } from '@server/entity/Session';
import { User } from '@server/entity/User';
import UserPasskey from '@server/entity/UserPasskey';
import { Permission } from '@server/lib/permissions';
import { sessionStoreFor } from '@server/lib/sessionStore';
import { getSettings } from '@server/lib/settings';
import { resetSignInMemoryForTests, stillMaySignIn } from '@server/lib/signIn';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

/*
 * Signing out other sessions when a password changes, a passkey or linked
 * account is removed, or the media server stops letting someone in, against
 * the real session store (sessions are database rows).
 */

/** Whether the media servers let the friend in; throws when unreachable. */
let mediaServerAnswer: () => Promise<boolean> = async () => true;
const askedPlex = mock.method(PlexTvAPI.prototype, 'getUsers', async () => {
  const shared = await mediaServerAnswer();
  return {
    MediaContainer: {
      User: [
        {
          $: { id: '2000' },
          Server: shared ? [{ $: { machineIdentifier: 'machine-1' } }] : [],
        },
      ],
    },
  } as unknown as Awaited<ReturnType<PlexTvAPI['getUsers']>>;
});
const askedJellyfin = mock.method(
  JellyfinAPI.prototype,
  'getAccount',
  async () => ({ Policy: { IsDisabled: !(await mediaServerAnswer()) } })
);

let app: Express;

before(() => {
  app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      store: sessionStoreFor(getRepository(Session)),
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/user', isAuthenticated(), userRoutes);
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

const signIn = async (email: string, password = 'test1234') => {
  getSettings().main.localLogin = true;
  const agent = request.agent(app);
  const res = await agent.post('/auth/local').send({ email, password });
  assert.equal(res.status, 200);
  return { agent, id: res.body.id as number };
};

const signedIn = async (agent: ReturnType<typeof request.agent>) =>
  (await agent.get('/auth/me')).status === 200;

/** The user's sessions still in the store. */
const sessionsOf = async (userId: number) =>
  (await getRepository(Session).find()).filter(
    (row) => (JSON.parse(row.json) as { userId?: number }).userId === userId
  ).length;

const passkeyFor = (user: User) =>
  getRepository(UserPasskey).save(
    new UserPasskey({
      user,
      credentialId: `cred-${user.id}`,
      publicKey: 'public-key',
      counter: '0',
      backedUp: false,
      name: 'Phone',
    })
  );

describe('signing out everywhere else', () => {
  it('follows changing your own password, but keeps you signed in here', async () => {
    const here = await signIn('friend@seerr.dev');
    const elsewhere = await signIn('friend@seerr.dev');
    const someoneElse = await signIn('admin@seerr.dev');

    const res = await here.agent
      .post(`/user/${here.id}/settings/password`)
      .send({ currentPassword: 'test1234', newPassword: 'new-password' });
    assert.equal(res.status, 204);

    assert.ok(await signedIn(here.agent));
    assert.ok(!(await signedIn(elsewhere.agent)));
    assert.ok(await signedIn(someoneElse.agent));
  });

  it('follows an admin setting someone’s password', async () => {
    const friend = await signIn('friend@seerr.dev');
    const admin = await signIn('admin@seerr.dev');

    const res = await admin.agent
      .post(`/user/${friend.id}/settings/password`)
      .send({ newPassword: 'new-password' });
    assert.equal(res.status, 204);

    assert.ok(!(await signedIn(friend.agent)));
    assert.ok(await signedIn(admin.agent));
  });

  it('follows a password reset', async () => {
    const friend = await signIn('friend@seerr.dev');
    await request(app)
      .post('/auth/reset-password')
      .send({ email: 'friend@seerr.dev' });
    const { resetPasswordGuid } = await getRepository(User)
      .createQueryBuilder('user')
      .addSelect('user.resetPasswordGuid')
      .where('user.email = :email', { email: 'friend@seerr.dev' })
      .getOneOrFail();

    const res = await request(app)
      .post(`/auth/reset-password/${resetPasswordGuid}`)
      .send({ password: 'new-password' });
    assert.equal(res.status, 200);

    assert.ok(!(await signedIn(friend.agent)));
  });

  it('follows removing one of your passkeys', async () => {
    const here = await signIn('friend@seerr.dev');
    const elsewhere = await signIn('friend@seerr.dev');
    const passkey = await passkeyFor(
      await getRepository(User).findOneByOrFail({ id: here.id })
    );

    const res = await here.agent.delete(`/auth/passkey/${passkey.id}`);
    assert.equal(res.status, 204);

    assert.ok(await signedIn(here.agent));
    assert.ok(!(await signedIn(elsewhere.agent)));
  });

  it('follows an admin removing someone’s passkey', async () => {
    const friend = await signIn('friend@seerr.dev');
    const admin = await signIn('admin@seerr.dev');
    const passkey = await passkeyFor(
      await getRepository(User).findOneByOrFail({ id: friend.id })
    );

    const res = await admin.agent.delete(
      `/user/${friend.id}/settings/passkeys/${passkey.id}`
    );
    assert.equal(res.status, 204);

    assert.ok(!(await signedIn(friend.agent)));
    assert.ok(await signedIn(admin.agent));
  });

  it('leaves someone whose number starts the same alone', async () => {
    const twelve = new User({
      email: 'twelve@seerr.dev',
      username: 'twelve',
      avatar: '',
      permissions: Permission.REQUEST,
      userType: UserType.LOCAL,
    });
    await twelve.setPassword('test1234');
    await getRepository(User).save(twelve);
    // Postgres assigns new row ids itself, whatever id is given.
    await getRepository(User).update(twelve.id, { id: 12 });
    const other = await signIn('twelve@seerr.dev');
    assert.equal(other.id, 12);
    const owner = await signIn('admin@seerr.dev');

    const res = await owner.agent
      .post('/user/1/settings/password')
      .send({ currentPassword: 'test1234', newPassword: 'new-password' });
    assert.equal(res.status, 204);

    assert.ok(await signedIn(other.agent));
    assert.ok(await signedIn(owner.agent));
  });
});

describe('signing out after unlinking an account', () => {
  it('follows removing a single sign-on link, by them or an admin', async () => {
    const here = await signIn('friend@seerr.dev');
    const elsewhere = await signIn('friend@seerr.dev');
    const friend = await getRepository(User).findOneByOrFail({ id: here.id });
    const links = getRepository(OidcLink);
    await links.save(
      new OidcLink({ user: friend, provider: 'glasswing', sub: 'glasswing-1' })
    );

    const own = await here.agent.delete(
      `/user/${here.id}/settings/linked-accounts/oidc/glasswing`
    );
    assert.equal(own.status, 204);
    assert.ok(await signedIn(here.agent));
    assert.ok(!(await signedIn(elsewhere.agent)));

    await links.save(
      new OidcLink({ user: friend, provider: 'lantern', sub: 'lantern-1' })
    );
    const admin = await signIn('admin@seerr.dev');
    const byAdmin = await admin.agent.delete(
      `/user/${here.id}/settings/linked-accounts/oidc/lantern`
    );
    assert.equal(byAdmin.status, 204);
    assert.ok(!(await signedIn(here.agent)));
    assert.ok(await signedIn(admin.agent));
  });
});

describe('a media server that stops letting someone in', () => {
  const settings = getSettings();
  const saved = {
    mediaServerType: settings.main.mediaServerType,
    machineId: settings.plex.machineId,
    jellyfin: { ...settings.jellyfin },
    emby: { ...settings.emby },
    connected: MEDIA_SERVER_KINDS.map((kind) => settings[kind].connected),
  };

  const SERVER_NAME: Record<MediaServerKind, string> = {
    plex: 'Plex',
    jellyfin: 'Jellyfin',
    emby: 'Emby',
  };

  /** Connects only `kind`, and makes the friend an account there. */
  const connect = async (kind: MediaServerKind) => {
    settings.main.mediaServerType = typeOfKind(kind);
    for (const other of MEDIA_SERVER_KINDS) {
      settings[other].connected = other === kind;
    }
    settings.plex.machineId = 'machine-1';
    Object.assign(settings.jellyfin, {
      ip: '192.0.2.10',
      port: 8096,
      apiKey: 'jellyfin-key',
    });
    Object.assign(settings.emby, {
      ip: '192.0.2.11',
      port: 8096,
      apiKey: 'emby-key',
    });
    const users = getRepository(User);
    await users.update(1, { plexToken: 'owner-token' });
    const friend = await users.findOneByOrFail({ email: 'friend@seerr.dev' });
    await users.update(
      friend.id,
      kind === 'plex'
        ? { userType: UserType.PLEX, plexId: 2000 }
        : kind === 'jellyfin'
          ? { userType: UserType.JELLYFIN, jellyfinUserId: 'jf-friend' }
          : { userType: UserType.EMBY, embyUserId: 'emby-friend' }
    );
  };

  const asked = () =>
    askedPlex.mock.callCount() + askedJellyfin.mock.callCount();

  beforeEach(() => {
    mediaServerAnswer = async () => true;
    resetSignInMemoryForTests();
  });

  afterEach(() => {
    settings.main.mediaServerType = saved.mediaServerType;
    settings.plex.machineId = saved.machineId;
    Object.assign(settings.jellyfin, saved.jellyfin);
    Object.assign(settings.emby, saved.emby);
    MEDIA_SERVER_KINDS.forEach((kind, i) => {
      settings[kind].connected = saved.connected[i];
    });
    resetSignInMemoryForTests();
  });

  for (const kind of MEDIA_SERVER_KINDS) {
    it(`signs out everywhere someone ${SERVER_NAME[kind]} no longer lets in`, async () => {
      await connect(kind);
      const here = await signIn('friend@seerr.dev');
      const elsewhere = await signIn('friend@seerr.dev');
      const owner = await signIn('admin@seerr.dev');
      assert.ok(await signedIn(here.agent));
      assert.ok(await signedIn(owner.agent));

      mediaServerAnswer = async () => false;
      // The last answer holds for a few minutes.
      assert.ok(await signedIn(here.agent));

      resetSignInMemoryForTests();
      // Answered from the last check while the media server is asked again.
      assert.ok(await signedIn(here.agent));
      await stillMaySignIn(
        await getRepository(User).findOneByOrFail({ id: here.id })
      );
      assert.ok(!(await signedIn(here.agent)));
      assert.ok(!(await signedIn(elsewhere.agent)));
      assert.equal(await sessionsOf(here.id), 0);
      assert.ok(await signedIn(owner.agent));

      // Let in again, they sign in as before.
      mediaServerAnswer = async () => true;
      const again = await signIn('friend@seerr.dev');
      assert.ok(await signedIn(again.agent));
    });

    it(`keeps everyone signed in while ${SERVER_NAME[kind]} cannot be reached`, async () => {
      await connect(kind);
      const here = await signIn('friend@seerr.dev');

      mediaServerAnswer = async () => {
        throw new Error('connect ECONNREFUSED 192.0.2.10:8096');
      };
      resetSignInMemoryForTests();
      assert.ok(await signedIn(here.agent));
      assert.equal(await sessionsOf(here.id), 1);
    });
  }

  for (const kind of ['jellyfin', 'emby'] as const) {
    it(`keeps everyone signed in while Seerr has no ${SERVER_NAME[kind]} API key`, async () => {
      await connect(kind);
      const here = await signIn('friend@seerr.dev');

      settings[kind].apiKey = '';
      mediaServerAnswer = async () => false;
      resetSignInMemoryForTests();
      assert.ok(await signedIn(here.agent));
    });
  }

  it('asks the media server once for many requests', async () => {
    await connect('jellyfin');
    const here = await signIn('friend@seerr.dev');
    resetSignInMemoryForTests();
    const before = asked();

    const answers = await Promise.all(
      Array.from({ length: 5 }, () => signedIn(here.agent))
    );
    assert.deepEqual(answers, [true, true, true, true, true]);
    assert.ok(await signedIn(here.agent));
    assert.equal(asked() - before, 1);
  });

  it('answers at once while the media server is slow', async () => {
    await connect('jellyfin');
    const here = await signIn('friend@seerr.dev');
    resetSignInMemoryForTests();
    let answer: (ok: boolean) => void = () => undefined;
    mediaServerAnswer = () =>
      new Promise<boolean>((resolve) => (answer = resolve));

    const started = Date.now();
    assert.ok(await signedIn(here.agent));
    assert.ok(Date.now() - started < 2000);
    answer(true);
  });

  it('reads the Plex share list once for several people', async () => {
    await connect('plex');
    const users = getRepository(User);
    await users.save(
      users.create({
        email: 'harbourlights@example.invalid',
        username: 'harbourlights',
        userType: UserType.PLEX,
        plexId: 2001,
        permissions: Permission.REQUEST,
        avatar: '',
      })
    );
    resetSignInMemoryForTests();
    const before = askedPlex.mock.callCount();
    await Promise.all(
      [2000, 2001].map(async (plexId) =>
        stillMaySignIn(await users.findOneByOrFail({ plexId }))
      )
    );
    assert.equal(askedPlex.mock.callCount() - before, 1);
  });

  it('never asks about the owner', async () => {
    await connect('plex');
    const owner = await signIn('admin@seerr.dev');
    mediaServerAnswer = async () => false;
    const before = asked();
    assert.ok(await signedIn(owner.agent));
    assert.equal(asked() - before, 0);
  });

  it('follows unlinking a media server account', async () => {
    await connect('jellyfin');
    const users = getRepository(User);
    const friend = await users.findOneByOrFail({ email: 'friend@seerr.dev' });
    // A password account with Jellyfin linked.
    await users.update(friend.id, { userType: UserType.LOCAL });
    const here = await signIn('friend@seerr.dev');
    const elsewhere = await signIn('friend@seerr.dev');

    const res = await here.agent.delete(
      `/user/${here.id}/settings/linked-accounts/jellyfin`
    );
    assert.equal(res.status, 204);
    assert.equal(
      (await users.findOneByOrFail({ id: here.id })).jellyfinUserId,
      null
    );
    assert.ok(await signedIn(here.agent));
    assert.ok(!(await signedIn(elsewhere.agent)));
  });
});
