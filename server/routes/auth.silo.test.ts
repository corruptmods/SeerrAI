import SiloAPI from '@server/api/silo/client';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import SiloPlay from '@server/entity/SiloPlay';
import { User } from '@server/entity/User';
import { scheduledJobs } from '@server/job/schedule';
import PreparedEmail from '@server/lib/email';
import { siloCheck } from '@server/lib/health';
import { Permission } from '@server/lib/permissions';
import { getSettings, siloDefaults } from '@server/lib/settings';
import {
  maySignIn,
  resetSignInMemoryForTests,
  stillMaySignIn,
} from '@server/lib/signIn';
import {
  checkSiloDevice,
  resetSiloDevicesForTests,
  resetSiloIdentityForTests,
  siloPasswordSignIn,
  startSiloDevice,
} from '@server/lib/siloAccounts';
import { finishSiloReset } from '@server/lib/siloConnect';
import { importSiloUsers } from '@server/lib/siloUserImport';
import userAccessCheck from '@server/lib/userAccessCheck';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import { createFakeSilo } from '@server/test/fakeSilo';
import express from 'express';
import session from 'express-session';
import schedule from 'node-schedule';
import assert from 'node:assert/strict';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';
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
  resetSiloIdentityForTests();
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

describe('a different Silo at the same address', () => {
  it('signs nobody in, by password or by code, and Health says so', async () => {
    const linked = await users().save(
      new User({
        email: 'old-link@example.invalid',
        siloUserId: 'acct-guest',
        siloUsername: 'lantern',
        userType: UserType.SILO,
        permissions: 0,
        avatar: '',
      })
    );
    // Rebuilt: the same small account ids now name other people.
    silo.serverId = '9c1d2e3f-0000-4000-8000-000000000001';

    const res = await request(app)
      .post('/auth/silo')
      .send({ username: 'lantern', password: 'song' });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /not the one Seerr AI was connected to/);
    assert.deepEqual(silo.openSessions(), []);
    assert.ok(!silo.calls.some((call) => call.path === '/auth/login'));

    const agent = request.agent(app);
    const code = (await agent.post('/auth/silo/device/start')).body;
    silo.approveDevice(code.userCode, 'acct-guest');
    const check = await agent
      .post('/auth/silo/device/check')
      .send({ handle: code.handle });
    assert.equal(check.status, 409);
    assert.notEqual((await agent.get('/auth/me')).body.id, linked.id);

    const health = await siloCheck(
      new SiloAPI(`http://127.0.0.1:${silo.port()}`, 'sa_test'),
      getSettings().silo.serverId
    );
    assert.equal(health.status, 'error');
    assert.ok(
      health.items.some((item) => /different Silo/.test(item.title)),
      JSON.stringify(health)
    );

    // The same Silo again: back to normal.
    silo.serverId = getSettings().silo.serverId;
    resetSiloIdentityForTests();
    const again = await request(app)
      .post('/auth/silo')
      .send({ username: 'lantern', password: 'song' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
  });
});

describe('after a different Silo was connected', () => {
  /** Someone whose account came from the old Silo, as the reset left it. */
  const unlinked = (fields: Partial<User> = {}) =>
    users().save(
      new User({
        email: 'lantern',
        siloUserId: null,
        siloUsername: 'Lantern',
        userType: UserType.SILO,
        permissions: 0,
        avatar: '',
        ...fields,
      })
    );

  it('links someone again by their Silo name when they sign in', async () => {
    const left = await unlinked();
    const res = await request(app)
      .post('/auth/silo')
      .send({ username: 'lantern', password: 'song' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.id, left.id);
    const user = await users().findOneByOrFail({ id: left.id });
    assert.equal(user.siloUserId, 'acct-guest');
    assert.equal(user.siloUsername, 'lantern');
    assert.equal(await users().countBy({ siloUserId: 'acct-guest' }), 1);
  });

  it('never links an administrator, the owner or someone with a password by name', async () => {
    await unlinked({ permissions: Permission.ADMIN });
    let res = await request(app)
      .post('/auth/silo')
      .send({ username: 'lantern', password: 'song' });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, ApiErrorCode.ExistingAccount);

    await users().delete({ email: 'lantern' });
    const withPassword = await unlinked();
    await withPassword.setPassword('Static Garden 1');
    await users().save(withPassword);
    res = await request(app)
      .post('/auth/silo')
      .send({ username: 'lantern', password: 'song' });
    assert.equal(res.status, 403);
    assert.equal(
      (await users().findOneByOrFail({ id: withPassword.id })).siloUserId,
      null
    );

    await users().update(1, {
      siloUserId: null,
      siloUsername: 'harbour',
      userType: UserType.SILO,
    });
    await users().update(1, { password: () => 'NULL' } as never);
    await request(app)
      .post('/auth/silo')
      .send({ username: 'harbour', password: 'lights' });
    assert.equal((await users().findOneByOrFail({ id: 1 })).siloUserId, null);
  });

  it('links someone again on Import Silo Users', async () => {
    const left = await unlinked();
    const result = await importSiloUsers(['acct-guest']);
    assert.equal(result.createdUsers.length, 0);
    assert.deepEqual(result.skippedUsers, []);
    assert.equal(
      (await users().findOneByOrFail({ id: left.id })).siloUserId,
      'acct-guest'
    );
  });
});

describe('a new Silo user’s email', () => {
  it('is confirmed by mail when Silo didn’t vouch for it', async () => {
    const settings = getSettings();
    const before = {
      email: settings.notifications.agents.email.enabled,
      url: settings.main.applicationUrl,
    };
    settings.notifications.agents.email.enabled = true;
    settings.main.applicationUrl = 'https://seerr.example.invalid';
    const sent = mock.method(PreparedEmail.prototype, 'send', async () => {
      return undefined;
    });
    try {
      const res = await request(app).post('/auth/silo').send({
        username: 'lantern',
        password: 'song',
        email: 'lantern@example.invalid',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const user = await users().findOneByOrFail({ siloUserId: 'acct-guest' });
      assert.equal(user.emailVerified, false);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(sent.mock.callCount(), 1);
      const [message] = sent.mock.calls[0].arguments as [
        { message: { to: string } },
      ];
      assert.equal(message.message.to, 'lantern@example.invalid');
    } finally {
      sent.mock.restore();
      settings.notifications.agents.email.enabled = before.email;
      settings.main.applicationUrl = before.url;
    }
  });
});

describe('signing in to Silo with a code', () => {
  const start = async (agent = request.agent(app)) => {
    const res = await agent.post('/auth/silo/device/start');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { agent, code: res.body };
  };

  it('shows the code and Silo’s page, and signs in once approved', async () => {
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
    // Silo names no profile for a full sign-in; it is chosen later.
    assert.equal(user.siloProfileId, null);
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
    // The key it made was deleted again before signing out of Silo.
    assert.deepEqual(
      [...silo.keys.keys()].filter((key) => key.startsWith('sa_made_')),
      []
    );
    assert.deepEqual(silo.openSessions(), []);
  });

  it('forgets an older Silo only once the owner is saved', async () => {
    const linked = await users().save(
      new User({
        email: 'old-silo@example.invalid',
        siloUserId: 'acct-guest',
        siloUsername: 'lantern',
        userType: UserType.LOCAL,
        permissions: 0,
        avatar: '',
      })
    );
    getSettings().silo = { ...siloDefaults(), serverId: 'an-older-silo' };
    const settings = getSettings();
    const save = settings.save;
    settings.save = async () => {
      throw new Error('disk full');
    };
    const setUp = () =>
      request(app).post('/auth/silo').send({
        username: 'harbour',
        password: 'lights',
        hostname: '127.0.0.1',
        port: silo.port(),
      });
    try {
      assert.equal((await setUp()).status, 500);
    } finally {
      settings.save = save;
    }
    // Nothing of the reset happened.
    assert.equal(
      (await users().findOneByOrFail({ id: linked.id })).siloUserId,
      'acct-guest'
    );

    const res = await setUp();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(
      (await users().findOneByOrFail({ id: linked.id })).siloUserId,
      null
    );
    // The owner stays linked to the Silo they set up with.
    assert.equal(
      (await users().findOneByOrFail({ id: res.body.id })).siloUserId,
      'acct-owner'
    );
  });

  it('keeps the key it made when forgetting the older Silo fails, and finishes that later', async (t) => {
    const linked = await users().save(
      new User({
        email: 'old-silo@example.invalid',
        siloUserId: 'acct-guest',
        siloUsername: 'lantern',
        userType: UserType.LOCAL,
        permissions: 0,
        avatar: '',
      })
    );
    getSettings().silo = { ...siloDefaults(), serverId: 'an-older-silo' };
    const failing = t.mock.method(
      getRepository(SiloPlay),
      'clear',
      async () => {
        throw new Error('The disk is full.');
      }
    );
    const res = await request(app).post('/auth/silo').send({
      username: 'harbour',
      password: 'lights',
      hostname: '127.0.0.1',
      port: silo.port(),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // Silo and the settings agree on the key it made.
    const key = getSettings().silo.apiKey;
    assert.match(key, /^sa_made_/);
    assert.ok(silo.keys.has(key), 'the key is still in Silo');
    assert.deepEqual(silo.openSessions(), []);
    // The reset waits, and Silo is closed until it is done.
    assert.equal(getSettings().silo.resetPending?.userId, res.body.id);
    await assert.rejects(() => siloPasswordSignIn('lantern', 'song'));
    failing.mock.restore();
    assert.equal(await finishSiloReset(), true);
    assert.equal(
      (await users().findOneByOrFail({ id: linked.id })).siloUserId,
      null
    );
    assert.equal(
      (await users().findOneByOrFail({ id: res.body.id })).siloUserId,
      'acct-owner'
    );
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

// Last: the limit on asking for codes lasts beyond one test.
describe('asking Silo for codes', () => {
  it('makes room per address, never crowding out someone else', async () => {
    const other = await startSiloDevice('203.0.113.9');
    const mine = [];
    for (let i = 0; i < 6; i++) {
      mine.push(await startSiloDevice('198.51.100.7'));
    }
    // The address's oldest went to make room for its sixth.
    assert.deepEqual(await checkSiloDevice(mine[0].handle), {
      status: 'expired',
    });
    assert.equal((await checkSiloDevice(mine[5].handle)).status, 'pending');
    assert.equal((await checkSiloDevice(other.handle)).status, 'pending');
  });

  it('limits how many codes one address asks for', async () => {
    // Ten in a window (earlier tests here asked for some of them).
    let res;
    for (let i = 0; i < 11; i++) {
      res = await request(app).post('/auth/silo/device/start');
      if (res.status !== 200) break;
    }
    assert.equal(res?.status, 429);
    assert.ok(Number(res?.headers['retry-after']) > 0);
    assert.equal(
      (await request(app).post('/auth/silo/device/start')).status,
      429
    );
  });
});
