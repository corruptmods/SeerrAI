import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { scheduledJobs } from '@server/job/schedule';
import { getSettings, siloDefaults } from '@server/lib/settings';
import {
  maySignIn,
  resetSignInMemoryForTests,
  stillMaySignIn,
} from '@server/lib/signIn';
import { resetSiloDevicesForTests } from '@server/lib/siloAccounts';
import userAccessCheck from '@server/lib/userAccessCheck';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import { createFakeSilo } from '@server/test/fakeSilo';
import express from 'express';
import session from 'express-session';
import schedule from 'node-schedule';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

/*
 * Signing in with a Silo account: a password, a code approved in Silo, and
 * first-run setup with Silo as the primary server, against a stand-in Silo.
 */

setupTestDb();

const silo = createFakeSilo();
let app: express.Express;

before(async () => {
  await silo.start();
  app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
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
});

after(() => silo.stop());

beforeEach(() => {
  silo.reset();
  resetSiloDevicesForTests();
  resetSignInMemoryForTests();
  silo.accounts = [
    {
      id: 'acct-owner',
      username: 'harbour',
      password: 'lights',
      role: 'admin',
      profiles: [{ id: 'p-owner', name: 'Harbour', is_primary: true }],
    },
    {
      id: 'acct-guest',
      username: 'lantern',
      password: 'song',
      role: 'user',
      profiles: [
        { id: 'p-guest', name: 'Lantern', is_primary: true },
        { id: 'p-kid', name: 'Garden', is_primary: false, is_child: true },
      ],
    },
  ];
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.main.newPlexLogin = true;
  settings.main.localLogin = true;
  settings.main.mediaServerLogin = true;
  settings.plex.connected = true;
  settings.jellyfin.connected = false;
  settings.emby.connected = false;
  settings.silo = silo.settings({ signIn: true });
});

afterEach(async () => {
  await schedule.gracefulShutdown();
  scheduledJobs.length = 0;
});

const users = () => getRepository(User);

describe('signing in to Silo with a password', () => {
  it('makes an account for someone new, and signs out of Silo at once', async () => {
    const agent = request.agent(app);
    const res = await agent
      .post('/auth/silo')
      .send({ username: 'lantern', password: 'song', email: 'lantern' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const user = await users().findOneByOrFail({ siloUserId: 'acct-guest' });
    assert.equal(user.userType, UserType.SILO);
    assert.equal(user.siloUsername, 'lantern');
    assert.equal(user.email, 'lantern');
    assert.equal(user.siloProfileId, null);
    assert.equal(user.avatar, '/avatarproxy/silo/acct-guest');
    assert.deepEqual(silo.openSessions(), [], 'no Silo session kept');
    const login = silo.calls.find((c) => c.path === '/auth/login');
    assert.deepEqual(login?.body, { username: 'lantern', password: 'song' });
    // Signed in here.
    assert.equal((await agent.get('/auth/me')).body.id, user.id);
  });

  it('signs an existing account in, keeping who they are', async () => {
    await users().update(2, {
      siloUserId: 'acct-guest',
      siloUsername: 'old-name',
    });
    const res = await request(app)
      .post('/auth/silo')
      .send({ username: 'lantern', password: 'song' });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 2);
    const user = await users().findOneByOrFail({ id: 2 });
    assert.equal(user.siloUsername, 'lantern');
    assert.equal(user.userType, UserType.PLEX, 'main account unchanged');
  });

  it('refuses someone whose name another account has, asking them to link instead', async () => {
    await users().update(2, { email: 'lantern' });
    const res = await request(app)
      .post('/auth/silo')
      .send({ username: 'lantern', password: 'song' });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, ApiErrorCode.ExistingAccount);
    assert.equal(await users().countBy({ siloUserId: 'acct-guest' }), 0);
  });

  it('refuses someone new while new users may not sign in', async () => {
    getSettings().main.newPlexLogin = false;
    const res = await request(app)
      .post('/auth/silo')
      .send({ username: 'lantern', password: 'song' });
    assert.equal(res.status, 403);
    assert.equal(await users().countBy({ siloUserId: 'acct-guest' }), 0);
  });

  it('says plainly why Silo refused', async () => {
    const reason = async (username: string, password: string) => {
      const res = await request(app)
        .post('/auth/silo')
        .send({ username, password });
      return [res.status, res.body.message];
    };
    assert.deepEqual(await reason('lantern', 'wrong'), [
      401,
      ApiErrorCode.InvalidCredentials,
    ]);
    silo.lockedNames.add('lantern');
    assert.deepEqual(await reason('lantern', 'song'), [
      429,
      'Silo has paused sign-in for this name after too many tries. Try again in a few minutes.',
    ]);
    silo.lockedNames.clear();
    silo.accounts[1].passwordChangeRequired = true;
    assert.deepEqual(await reason('lantern', 'song'), [
      403,
      ApiErrorCode.PasswordChangeRequired,
    ]);
    assert.deepEqual(silo.openSessions(), [], 'signed out even so');
    silo.down = true;
    assert.deepEqual(await reason('lantern', 'song'), [
      502,
      ApiErrorCode.ConnectionError,
    ]);
  });

  it('is refused while Silo sign-in is off', async () => {
    getSettings().silo.signIn = false;
    const res = await request(app)
      .post('/auth/silo')
      .send({ username: 'lantern', password: 'song' });
    assert.equal(res.status, 403);
    assert.equal(silo.calls.length, 0, 'Silo not asked');
  });
});

describe('signing in to Silo with a code', () => {
  const start = async (agent = request.agent(app)) => {
    const res = await agent.post('/auth/silo/device/start');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { agent, code: res.body };
  };

  it('shows the code and Silo’s page, and signs in once approved as a profile', async () => {
    const { agent, code } = await start();
    assert.match(code.userCode, /^\d{4}-\d{4}$/);
    assert.match(code.verificationUrl, /\/activate\?code=\d{8}$/);
    assert.match(code.handle, /^[a-f0-9]{48}$/);
    assert.ok(!JSON.stringify(code).includes('device-'), 'no device code');

    let res = await agent
      .post('/auth/silo/device/check')
      .send({ handle: code.handle });
    assert.deepEqual(res.body, { status: 'pending', opened: false });

    silo.approveDevice(code.userCode, 'acct-guest', 'p-kid');
    res = await agent
      .post('/auth/silo/device/check')
      .send({ handle: code.handle });
    assert.equal(res.body.status, 'approved');
    const user = await users().findOneByOrFail({ siloUserId: 'acct-guest' });
    assert.equal(res.body.user.id, user.id);
    assert.equal(user.siloProfileId, 'p-kid', 'the approved profile is kept');
    assert.deepEqual(silo.openSessions(), []);
    assert.equal((await agent.get('/auth/me')).body.id, user.id);

    // The code is used up.
    res = await agent
      .post('/auth/silo/device/check')
      .send({ handle: code.handle });
    assert.deepEqual(res.body, { status: 'expired' });
  });

  it('points people at Silo’s external address', async () => {
    getSettings().silo.externalHostname = 'https://silo.example.invalid';
    const { code } = await start();
    assert.match(
      code.verificationUrl,
      /^https:\/\/silo\.example\.invalid\/activate\?code=\d{8}$/
    );
  });

  it('reports a refused code, and is closed during setup or with sign-in off', async () => {
    const { agent, code } = await start();
    silo.denyDevice(code.userCode);
    const res = await agent
      .post('/auth/silo/device/check')
      .send({ handle: code.handle });
    assert.deepEqual(res.body, { status: 'denied' });

    getSettings().silo.signIn = false;
    assert.equal(
      (await request(app).post('/auth/silo/device/start')).status,
      403
    );
  });
});

describe('setting up with Silo as the primary server', () => {
  beforeEach(() => {
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.NOT_CONFIGURED;
    settings.plex.connected = false;
    settings.silo = siloDefaults();
  });

  it('makes the Silo administrator the owner and Silo primary', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/auth/silo').send({
      username: 'harbour',
      password: 'lights',
      hostname: '127.0.0.1',
      port: silo.port(),
      useSsl: false,
      urlBase: '',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.id, 1);
    const settings = getSettings();
    assert.equal(settings.main.mediaServerType, MediaServerType.SILO);
    assert.equal(settings.silo.connected, true);
    assert.equal(settings.silo.signIn, true);
    assert.match(settings.silo.apiKey, /^sa_made_/);
    const owner = await users().findOneByOrFail({ id: 1 });
    assert.equal(owner.siloUserId, 'acct-owner');
    assert.equal(owner.userType, UserType.SILO);
    assert.deepEqual(silo.openSessions(), []);
  });

  it('refuses before making a key when the owner’s email is taken', async () => {
    await users().save([
      new User({ email: 'first@test.local', avatar: '' }),
      new User({ email: 'harbour', avatar: '' }),
    ]);
    const res = await request(app).post('/auth/silo').send({
      username: 'harbour',
      password: 'lights',
      hostname: '127.0.0.1',
      port: silo.port(),
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, ApiErrorCode.ExistingAccount);
    assert.ok(
      !silo.calls.some(
        (c) => c.method === 'POST' && c.path === '/admin/api-keys'
      ),
      'no key made'
    );
    assert.deepEqual([...silo.keys.keys()], ['sa_test']);
    assert.deepEqual(silo.openSessions(), []);
    assert.equal(
      getSettings().main.mediaServerType,
      MediaServerType.NOT_CONFIGURED
    );
  });

  it('puts the settings back when saving the owner fails', async () => {
    const settings = getSettings();
    const save = settings.save;
    settings.save = async () => {
      throw new Error('disk full');
    };
    try {
      const res = await request(app).post('/auth/silo').send({
        username: 'harbour',
        password: 'lights',
        hostname: '127.0.0.1',
        port: silo.port(),
      });
      assert.equal(res.status, 500);
    } finally {
      settings.save = save;
    }
    assert.equal(
      getSettings().main.mediaServerType,
      MediaServerType.NOT_CONFIGURED
    );
    assert.equal(getSettings().silo.connected, false);
    assert.equal(getSettings().silo.apiKey, '');
  });

  it('only lets a Silo administrator set up', async () => {
    const res = await request(app).post('/auth/silo').send({
      username: 'lantern',
      password: 'song',
      hostname: '127.0.0.1',
      port: silo.port(),
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, ApiErrorCode.NotAdmin);
    assert.equal(
      getSettings().main.mediaServerType,
      MediaServerType.NOT_CONFIGURED
    );
  });
});

describe('whether Silo still lets someone in', () => {
  const person = async () => {
    await users().update(2, {
      siloUserId: 'acct-guest',
      siloUsername: 'lantern',
      userType: UserType.SILO,
      plexId: null,
    });
    return users().findOneByOrFail({ id: 2 });
  };

  it('lets them in while their account is there and switched on', async () => {
    const user = await person();
    assert.equal(await maySignIn(user, 'passkey'), true);
    silo.accounts[1].enabled = false;
    assert.equal(await maySignIn(user, 'passkey'), false);
    silo.accounts = silo.accounts.slice(0, 1);
    assert.equal(await maySignIn(user, 'password'), false);
  });

  it('keeps someone signed in while Silo is down', async () => {
    const user = await person();
    silo.down = true;
    assert.equal(await stillMaySignIn(user), true);
  });

  it('removes someone Silo switched off, on the second check in a row', async () => {
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.SILO;
    settings.plex.connected = false;
    settings.main.removeUsersWithoutAccess = true;
    try {
      const user = await person();
      // A third account, so not every Silo user looks gone.
      await users().save(
        new User({
          email: 'garden@example.invalid',
          siloUserId: 'acct-owner',
          siloUsername: 'harbour',
          userType: UserType.SILO,
          permissions: 32,
          avatar: '',
        })
      );
      assert.equal(await userAccessCheck.run(), 0);
      silo.accounts[1].enabled = false;
      assert.equal(await userAccessCheck.run(), 0, 'first check: noted');
      silo.down = true;
      assert.equal(await userAccessCheck.run(), 0, 'Silo down: nobody');
      silo.down = false;
      assert.equal(await userAccessCheck.run(), 0, 'counting starts over');
      assert.equal(await userAccessCheck.run(), 1);
      assert.equal(await users().countBy({ id: user.id }), 0);
    } finally {
      settings.main.removeUsersWithoutAccess = false;
    }
  });
});
