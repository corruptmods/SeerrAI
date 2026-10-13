import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import PreparedEmail from '@server/lib/email';
import ImageProxy from '@server/lib/imageproxy';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import { ApiError } from '@server/types/error';
import axios from 'axios';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';

const emailMock = mock.method(PreparedEmail.prototype, 'send', async () => {
  return undefined;
}).mock;

// Jellyfin Quick Connect mocks
const defaultInitiateResponse = {
  Secret: 'abc123def456abc123def456',
  Code: '123456',
  DateAdded: new Date().toISOString(),
};

const defaultCheckResponse = {
  Authenticated: false,
  Secret: 'abc123def456abc123def456',
  Code: '123456',
  DeviceId: 'device-1',
  DeviceName: 'Test',
  AppName: 'Seerr',
  AppVersion: '1.0',
  DateAdded: new Date().toISOString(),
};

const defaultAuthenticateResponse = {
  User: {
    Id: 'jf-qc-user-001',
    Name: 'quickconnectuser',
    ServerId: 'server-1',
    Policy: { IsAdministrator: false },
  },
  AccessToken: 'fake-qc-access-token',
};

const initiateQCMock = mock.method(
  JellyfinAPI.prototype,
  'initiateQuickConnect',
  async () => ({ ...defaultInitiateResponse })
);

const checkQCMock = mock.method(
  JellyfinAPI.prototype,
  'checkQuickConnect',
  async () => ({ ...defaultCheckResponse })
);

const authenticateQCMock = mock.method(
  JellyfinAPI.prototype,
  'authenticateQuickConnect',
  async () => ({ ...defaultAuthenticateResponse })
);
const fakeAvatarBuffer = Buffer.from('fake-quickconnect-avatar-bytes');

const axiosHeadMock = mock.method(axios, 'head', async () => ({
  status: 200,
  headers: { 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' },
}));

const clearCachedImageMock = mock.method(
  ImageProxy.prototype,
  'clearCachedImage',
  async () => undefined
);

const getImageMock = mock.method(
  ImageProxy.prototype,
  'getImage',
  async () => ({
    imageBuffer: fakeAvatarBuffer,
    meta: {
      revalidateAfter: 3600,
      curRevalidate: 3600,
      isStale: false,
      etag: 'mock-meta-etag',
      extension: 'jpg',
      cacheKey: 'mock-cache-key',
      cacheMiss: true,
    },
  })
);

let app: Express;

function createApp() {
  const app = express();
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
  // Error handler matching how next({ status, message }) calls are handled
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // We must provide a next function for the function signature here even though its not used
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(async () => {
  app = createApp();
});

setupTestDb();

/** Create a supertest agent that is logged in as the given user. */
async function authenticatedAgent(email: string, password: string) {
  const agent = request.agent(app);
  const settings = getSettings();
  settings.main.localLogin = true;

  const res = await agent.post('/auth/local').send({ email, password });

  assert.strictEqual(res.status, 200);
  return agent;
}

/** Configure Jellyfin settings for testing QC */
function configureJellyfin() {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.JELLYFIN;
  settings.main.newPlexLogin = true;
  settings.jellyfin.ip = 'localhost';
  settings.jellyfin.port = 8096;
  settings.jellyfin.useSsl = false;
  settings.jellyfin.urlBase = '';
}

describe('POST /auth/jellyfin/quickconnect/initiate', () => {
  beforeEach(() => {
    initiateQCMock.mock.resetCalls();
    initiateQCMock.mock.mockImplementation(async () => ({
      ...defaultInitiateResponse,
    }));
    configureJellyfin();
  });

  it('returns code and secret on success', async () => {
    const res = await request(app).post('/auth/jellyfin/quickconnect/initiate');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.code, '123456');
    assert.strictEqual(res.body.secret, 'abc123def456abc123def456');
    assert.strictEqual(initiateQCMock.mock.callCount(), 1);
  });

  it('returns 403 when the media server is Emby', async () => {
    getSettings().main.mediaServerType = MediaServerType.EMBY;

    const res = await request(app).post('/auth/jellyfin/quickconnect/initiate');

    assert.strictEqual(res.status, 403);
    assert.strictEqual(initiateQCMock.mock.callCount(), 0);
  });

  it('returns 500 when Jellyfin API fails', async () => {
    initiateQCMock.mock.mockImplementation(async () => {
      throw new Error('Connection refused');
    });

    const res = await request(app).post('/auth/jellyfin/quickconnect/initiate');

    assert.strictEqual(res.status, 500);
    assert.match(res.body.message, /initiate quick connect/i);
  });

  it('returns 500 when initiateQuickConnect throws ApiError', async () => {
    initiateQCMock.mock.mockImplementation(async () => {
      throw new ApiError(500, ApiErrorCode.Unknown);
    });

    const res = await request(app).post('/auth/jellyfin/quickconnect/initiate');
    assert.strictEqual(res.status, 500);
  });
});

describe('GET /auth/jellyfin/quickconnect/check', () => {
  beforeEach(() => {
    checkQCMock.mock.resetCalls();
    checkQCMock.mock.mockImplementation(async () => ({
      ...defaultCheckResponse,
    }));
    configureJellyfin();
  });

  it('returns authenticated: false when not yet authorized', async () => {
    const res = await request(app)
      .get('/auth/jellyfin/quickconnect/check')
      .query({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.authenticated, false);
    assert.strictEqual(checkQCMock.mock.callCount(), 1);
  });

  it('returns authenticated: true when authorized', async () => {
    checkQCMock.mock.mockImplementation(async () => ({
      ...defaultCheckResponse,
      Authenticated: true,
    }));

    const res = await request(app)
      .get('/auth/jellyfin/quickconnect/check')
      .query({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.authenticated, true);
  });

  it('returns 400 when secret is missing', async () => {
    const res = await request(app).get('/auth/jellyfin/quickconnect/check');

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /invalid secret/i);
    assert.strictEqual(checkQCMock.mock.callCount(), 0);
  });

  it('returns 400 when secret is too short', async () => {
    const res = await request(app)
      .get('/auth/jellyfin/quickconnect/check')
      .query({ secret: 'ab12' });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /invalid secret/i);
    assert.strictEqual(checkQCMock.mock.callCount(), 0);
  });

  it('returns 400 when secret is too long', async () => {
    const res = await request(app)
      .get('/auth/jellyfin/quickconnect/check')
      .query({ secret: 'a'.repeat(129) });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /invalid secret/i);
    assert.strictEqual(checkQCMock.mock.callCount(), 0);
  });

  it('returns 400 when secret contains non-hex characters', async () => {
    const res = await request(app)
      .get('/auth/jellyfin/quickconnect/check')
      .query({ secret: 'zzzzzzzzzzzz' });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /invalid secret/i);
    assert.strictEqual(checkQCMock.mock.callCount(), 0);
  });

  it('returns 403 when the media server is Emby', async () => {
    getSettings().main.mediaServerType = MediaServerType.EMBY;

    const res = await request(app)
      .get('/auth/jellyfin/quickconnect/check')
      .query({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(checkQCMock.mock.callCount(), 0);
  });

  it('returns error when Jellyfin API fails', async () => {
    checkQCMock.mock.mockImplementation(async () => {
      throw new ApiError(500, ApiErrorCode.Unknown);
    });

    const res = await request(app)
      .get('/auth/jellyfin/quickconnect/check')
      .query({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 500);
  });
});

describe('POST /auth/jellyfin/quickconnect/authenticate', () => {
  beforeEach(() => {
    authenticateQCMock.mock.resetCalls();
    authenticateQCMock.mock.mockImplementation(async () => ({
      ...defaultAuthenticateResponse,
    }));
    axiosHeadMock.mock.resetCalls();
    clearCachedImageMock.mock.resetCalls();
    getImageMock.mock.resetCalls();
    configureJellyfin();
  });

  it('returns 400 when secret is missing', async () => {
    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({});

    assert.strictEqual(res.status, 400);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 0);
  });

  it('returns 400 when secret is not a string', async () => {
    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 12345678 });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 0);
  });

  it('returns 400 when secret is too short', async () => {
    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'ab12' });

    assert.strictEqual(res.status, 400);
  });

  it('returns 400 when secret contains non-hex characters', async () => {
    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'zzzzzzzzzzzz' });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 0);
  });

  it('returns 403 when media server is not configured', async () => {
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.NOT_CONFIGURED;

    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 403);
    assert.match(res.body.message, /initial setup/i);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 0);
  });

  it('returns 403 when no users exist in the database', async () => {
    // Clear all users to simulate initial setup
    const userRepo = getRepository(User);
    // clear() issues TRUNCATE, which Postgres refuses while other tables
    // reference users. A plain delete empties it on either engine.
    await userRepo.createQueryBuilder().delete().execute();

    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 403);
    assert.match(res.body.message, /initial setup/i);
  });

  it('signs in an existing Jellyfin user and sets session', async () => {
    const userRepo = getRepository(User);
    const existingUser = new User({
      email: 'existing-qc@seerr.dev',
      jellyfinUsername: 'quickconnectuser',
      jellyfinUserId: 'jf-qc-user-001',
      jellyfinDeviceId: 'old-device-id',
      permissions: 0,
      avatar: '/avatarproxy/jf-qc-user-001?v=0',
      userType: UserType.JELLYFIN,
    });
    await userRepo.save(existingUser);

    const agent = request.agent(app);

    const res = await agent
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 200);
    assert.ok('id' in res.body);
    assert.ok(!('password' in res.body));

    const meRes = await agent.get('/auth/me');
    assert.strictEqual(meRes.status, 200);
    assert.strictEqual(meRes.body.jellyfinUsername, 'quickconnectuser');

    const updatedUser = await userRepo.findOneOrFail({
      where: { jellyfinUserId: 'jf-qc-user-001' },
      select: {
        id: true,
        jellyfinAuthToken: true,
        jellyfinDeviceId: true,
      },
    });
    assert.strictEqual(updatedUser.jellyfinAuthToken, 'fake-qc-access-token');
    assert.notStrictEqual(updatedUser.jellyfinDeviceId, 'old-device-id');
  });

  it('refreshes avatarVersion/avatarETag when the remote avatar has changed', async () => {
    const userRepo = getRepository(User);
    const existingUser = new User({
      email: 'qc-avatar-change@seerr.dev',
      jellyfinUsername: 'quickconnectuser',
      jellyfinUserId: 'jf-qc-user-001',
      jellyfinDeviceId: 'old-device-id',
      permissions: 0,
      avatar: '/avatarproxy/jf-qc-user-001?v=old',
      avatarVersion: 'old-version',
      avatarETag: 'old-etag',
      userType: UserType.JELLYFIN,
    });
    await userRepo.save(existingUser);

    const agent = request.agent(app);
    const res = await agent
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 200);

    const updatedUser = await userRepo.findOneOrFail({
      where: { jellyfinUserId: 'jf-qc-user-001' },
    });
    assert.notStrictEqual(updatedUser.avatarVersion, 'old-version');
    assert.notStrictEqual(updatedUser.avatarETag, 'old-etag');
    assert.notStrictEqual(
      updatedUser.avatar,
      '/avatarproxy/jf-qc-user-001?v=old'
    );
  });

  it('creates a new user when newPlexLogin is enabled and user does not exist', async () => {
    const settings = getSettings();
    settings.main.newPlexLogin = true;

    authenticateQCMock.mock.mockImplementation(async () => ({
      User: {
        Id: 'jf-brand-new-user',
        Name: 'brandnewuser',
        ServerId: 'server-1',
        Policy: { IsAdministrator: false },
      },
      AccessToken: 'new-user-token',
    }));

    const agent = request.agent(app);

    const res = await agent
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 200);
    assert.ok('id' in res.body);

    const userRepo = getRepository(User);
    const newUser = await userRepo.findOne({
      where: { jellyfinUserId: 'jf-brand-new-user' },
    });
    assert.ok(newUser);
    assert.strictEqual(newUser.jellyfinUsername, 'brandnewuser');
    assert.strictEqual(newUser.userType, UserType.JELLYFIN);

    const meRes = await agent.get('/auth/me');
    assert.strictEqual(meRes.status, 200);
  });

  it('returns 403 when the media server is Emby', async () => {
    getSettings().main.mediaServerType = MediaServerType.EMBY;

    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 0);
  });

  it('applies default permissions to newly created users', async () => {
    const settings = getSettings();
    settings.main.newPlexLogin = true;
    settings.main.defaultPermissions = 32;

    authenticateQCMock.mock.mockImplementation(async () => ({
      User: {
        Id: 'jf-perms-test-user',
        Name: 'permsuser',
        ServerId: 'server-1',
        Policy: { IsAdministrator: false },
      },
      AccessToken: 'perms-token',
    }));

    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 200);

    const userRepo = getRepository(User);
    const user = await userRepo.findOneOrFail({
      where: { jellyfinUserId: 'jf-perms-test-user' },
    });
    assert.strictEqual(user.permissions, 32);
  });

  it('returns 403 when newPlexLogin is disabled and user does not exist', async () => {
    const settings = getSettings();
    settings.main.newPlexLogin = false;

    authenticateQCMock.mock.mockImplementation(async () => ({
      User: {
        Id: 'jf-unknown-user',
        Name: 'unknownuser',
        ServerId: 'server-1',
        Policy: { IsAdministrator: false },
      },
      AccessToken: 'unknown-token',
    }));

    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.message, 'Access denied.');
  });

  it('returns error when Jellyfin authenticateQuickConnect fails', async () => {
    authenticateQCMock.mock.mockImplementation(async () => {
      throw new ApiError(401, ApiErrorCode.InvalidCredentials);
    });

    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.message, ApiErrorCode.InvalidCredentials);
  });

  it('returns 500 when Jellyfin throws a generic error', async () => {
    authenticateQCMock.mock.mockImplementation(async () => {
      throw new Error('Network timeout');
    });

    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 500);
  });
});

describe('GET /auth/me', () => {
  it('returns 403 when not authenticated', async () => {
    const res = await request(app).get('/auth/me');
    assert.strictEqual(res.status, 403);
  });

  it('returns the authenticated user', async () => {
    const agent = await authenticatedAgent('admin@seerr.dev', 'test1234');

    const res = await agent.get('/auth/me');

    assert.strictEqual(res.status, 200);
    assert.ok('id' in res.body);
    assert.strictEqual(res.body.displayName, 'admin');
    // Their own email, which is left out wherever they appear to others.
    assert.strictEqual(res.body.email, 'admin@seerr.dev');
  });

  it('sends the settings the app reads, and none of the credentials', async () => {
    const userRepo = getRepository(User);
    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
      relations: { settings: true },
    });
    admin.settings ??= new UserSettings();
    admin.settings.locale = 'fr';
    admin.settings.disabledFeatures = ['aiChat'];
    admin.settings.pushbulletAccessToken = 'SECRET-PUSHBULLET';
    admin.settings.pushoverUserKey = 'SECRET-PUSHOVER';
    admin.settings.telegramChatId = 'SECRET-TELEGRAM';
    admin.settings.pgpKey = 'SECRET-PGP';
    await userRepo.save(admin);

    const agent = await authenticatedAgent('admin@seerr.dev', 'test1234');
    const res = await agent.get('/auth/me');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.settings.locale, 'fr');
    assert.deepStrictEqual(res.body.settings.disabledFeatures, ['aiChat']);
    assert.doesNotMatch(JSON.stringify(res.body), /SECRET-/);
  });

  it('includes userEmailRequired warning when email is required but invalid', async () => {
    const settings = getSettings();
    settings.notifications.agents.email.options.userEmailRequired = true;

    // Change the user's email to something invalid
    const userRepo = getRepository(User);
    const user = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    user.email = 'not-an-email';
    await userRepo.save(user);

    // Log in with the changed email
    const agent = request.agent(app);
    settings.main.localLogin = true;
    const loginRes = await agent
      .post('/auth/local')
      .send({ email: 'not-an-email', password: 'test1234' });
    assert.strictEqual(loginRes.status, 200);

    const res = await agent.get('/auth/me');

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.warnings.includes('userEmailRequired'));

    settings.notifications.agents.email.options.userEmailRequired = false;
  });

  it('warns a user whose Plex sign-in has expired, and stops once it is fixed', async () => {
    const settings = getSettings();
    settings.main.localLogin = true;

    const userRepo = getRepository(User);
    const user = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    await userRepo.update(user.id, { plexTokenExpiredAt: new Date() });

    const agent = request.agent(app);
    const loginRes = await agent
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'test1234' });
    assert.strictEqual(loginRes.status, 200);

    const flagged = await agent.get('/auth/me');
    assert.ok(flagged.body.warnings.includes('plexTokenExpired'));

    await userRepo.update(user.id, { plexTokenExpiredAt: null });

    const fixed = await agent.get('/auth/me');
    assert.ok(!fixed.body.warnings.includes('plexTokenExpired'));
  });
});

describe('POST /auth/local', () => {
  beforeEach(() => {
    const settings = getSettings();
    settings.main.localLogin = true;
  });

  it('returns 200 and user data on valid credentials', async () => {
    const res = await request(app)
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'test1234' });

    assert.strictEqual(res.status, 200);
    assert.ok('id' in res.body);
    // filter() strips sensitive fields like password
    assert.ok(!('password' in res.body));
  });

  it('returns 403 on wrong password', async () => {
    const res = await request(app)
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'wrongpassword' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.message, 'Access denied.');
  });

  it('returns 403 for nonexistent user', async () => {
    const res = await request(app)
      .post('/auth/local')
      .send({ email: 'nobody@seerr.dev', password: 'test1234' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.message, 'Access denied.');
  });

  it('returns 500 when local login is disabled', async () => {
    const settings = getSettings();
    settings.main.localLogin = false;

    const res = await request(app)
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'test1234' });

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.error, 'Password sign-in is disabled.');
  });

  it('returns 500 when email is missing', async () => {
    const res = await request(app)
      .post('/auth/local')
      .send({ password: 'test1234' });

    assert.strictEqual(res.status, 500);
    assert.match(res.body.error, /email address and a password/);
  });

  it('returns 500 when password is missing', async () => {
    const res = await request(app)
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev' });

    assert.strictEqual(res.status, 500);
    assert.match(res.body.error, /email address and a password/);
  });

  it('is case-insensitive for email', async () => {
    const res = await request(app)
      .post('/auth/local')
      .send({ email: 'Admin@Seerr.Dev', password: 'test1234' });

    assert.strictEqual(res.status, 200);
    assert.ok('id' in res.body);
  });

  it('allows the non-admin user to log in', async () => {
    const res = await request(app)
      .post('/auth/local')
      .send({ email: 'friend@seerr.dev', password: 'test1234' });

    assert.strictEqual(res.status, 200);
    assert.ok('id' in res.body);
  });

  it('sets a session on successful login', async () => {
    const agent = request.agent(app);

    await agent
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'test1234' });

    // Session should persist — /me should succeed
    const meRes = await agent.get('/auth/me');
    assert.strictEqual(meRes.status, 200);
  });
});

describe('POST /auth/logout', () => {
  it('returns 200 when not logged in', async () => {
    const res = await request(app).post('/auth/logout');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
  });

  it('destroys session and returns 200 when logged in', async () => {
    const agent = await authenticatedAgent('admin@seerr.dev', 'test1234');

    // Verify session is active
    const meBeforeRes = await agent.get('/auth/me');
    assert.strictEqual(meBeforeRes.status, 200);

    const logoutRes = await agent.post('/auth/logout');
    assert.strictEqual(logoutRes.status, 200);
    assert.strictEqual(logoutRes.body.status, 'ok');

    // Session should be invalidated — /me should fail
    const meAfterRes = await agent.get('/auth/me');
    assert.strictEqual(meAfterRes.status, 403);
  });
});

describe('POST /auth/reset-password', () => {
  beforeEach(() => {
    emailMock.resetCalls();
  });

  it('returns 200 for a valid email', async () => {
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ email: 'admin@seerr.dev' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(emailMock.callCount(), 1);
  });

  it('returns 200 for nonexistent email (does not reveal user existence)', async () => {
    const res = await request(app)
      .post('/auth/reset-password')
      .send({ email: 'nonexistent@seerr.dev' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(emailMock.callCount(), 0);
  });

  it('returns 500 when email is missing', async () => {
    const res = await request(app).post('/auth/reset-password').send({});

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.message, 'Email address required.');
    assert.strictEqual(emailMock.callCount(), 0);
  });

  it('sets a resetPasswordGuid on the user', async () => {
    await request(app)
      .post('/auth/reset-password')
      .send({ email: 'admin@seerr.dev' });

    const userRepo = getRepository(User);
    const user = await userRepo
      .createQueryBuilder('user')
      .addSelect(['user.resetPasswordGuid', 'user.recoveryLinkExpirationDate'])
      .where('user.email = :email', { email: 'admin@seerr.dev' })
      .getOneOrFail();

    assert.notStrictEqual(user.resetPasswordGuid, undefined);
    assert.notStrictEqual(user.resetPasswordGuid, null);
    assert.notStrictEqual(user.recoveryLinkExpirationDate, undefined);
    assert.strictEqual(emailMock.callCount(), 1);
  });
});

describe('POST /auth/reset-password/:guid', () => {
  /** Trigger a password reset and return the guid. */
  async function getResetGuid(email: string): Promise<string> {
    await request(app).post('/auth/reset-password').send({ email });

    const userRepo = getRepository(User);
    const user = await userRepo
      .createQueryBuilder('user')
      .addSelect('user.resetPasswordGuid')
      .where('user.email = :email', { email })
      .getOneOrFail();

    return user.resetPasswordGuid!;
  }

  it('resets password with a valid guid and password', async () => {
    const guid = await getResetGuid('admin@seerr.dev');

    const res = await request(app)
      .post(`/auth/reset-password/${guid}`)
      .send({ password: 'newpassword123' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');

    // Old password no longer works
    const oldLogin = await request(app)
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'test1234' });
    assert.strictEqual(oldLogin.status, 403);

    // New password works
    const newLogin = await request(app)
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'newpassword123' });
    assert.strictEqual(newLogin.status, 200);
  });

  it('returns 500 for an invalid guid', async () => {
    const res = await request(app)
      .post('/auth/reset-password/invalid-guid-here')
      .send({ password: 'newpassword123' });

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.message, 'Invalid password reset link.');
  });

  it('returns 500 when password is too short', async () => {
    const guid = await getResetGuid('admin@seerr.dev');

    const res = await request(app)
      .post(`/auth/reset-password/${guid}`)
      .send({ password: 'short' });

    assert.strictEqual(res.status, 500);
    assert.strictEqual(
      res.body.message,
      'Password must be at least 8 characters long.'
    );
  });

  it('returns 500 when password is missing', async () => {
    const guid = await getResetGuid('admin@seerr.dev');

    const res = await request(app)
      .post(`/auth/reset-password/${guid}`)
      .send({});

    assert.strictEqual(res.status, 500);
    assert.strictEqual(
      res.body.message,
      'Password must be at least 8 characters long.'
    );
  });

  it('returns 500 for an expired recovery link', async () => {
    const guid = await getResetGuid('admin@seerr.dev');

    // Expire the link
    const userRepo = getRepository(User);
    const user = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    user.recoveryLinkExpirationDate = new Date('2020-01-01');
    await userRepo.save(user);

    const res = await request(app)
      .post(`/auth/reset-password/${guid}`)
      .send({ password: 'newpassword123' });

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.message, 'Invalid password reset link.');
  });

  it('cannot reuse a guid after successful reset', async () => {
    const guid = await getResetGuid('admin@seerr.dev');

    // First reset succeeds
    const first = await request(app)
      .post(`/auth/reset-password/${guid}`)
      .send({ password: 'newpassword123' });
    assert.strictEqual(first.status, 200);

    // Second reset with same guid fails (recoveryLinkExpirationDate was cleared)
    const second = await request(app)
      .post(`/auth/reset-password/${guid}`)
      .send({ password: 'anotherpassword' });
    assert.strictEqual(second.status, 500);
  });
});

/*
 * The Plex account plex.tv answers with, and whether the owner shares the
 * server with it. Set per test.
 */
let plexAccount = { id: 3000, email: 'plexfriend@example.com' };
let plexShared = true;
mock.method(PlexTvAPI.prototype, 'getUser', async () => ({
  ...plexAccount,
  uuid: 'uuid',
  username: 'plexfriend',
  title: 'plexfriend',
  thumb: 'https://plex.tv/thumb',
  authToken: 'plex-token',
}));
mock.method(PlexTvAPI.prototype, 'checkUserAccess', async () => plexShared);
/** Plex.tv answering, or not, for whether the owner shares with someone. */
let plexDown = false;
mock.method(PlexTvAPI.prototype, 'getUsers', async () => {
  if (plexDown) throw new Error('plex.tv did not answer');
  return {
    MediaContainer: {
      User: [
        {
          $: { id: '2000' },
          Server: plexShared ? [{ $: { machineIdentifier: 'machine-1' } }] : [],
        },
      ],
    },
  };
});

const jellyfinAccountMock = mock.method(
  JellyfinAPI.prototype,
  'getAccount',
  async () => ({ Policy: { IsDisabled: false } })
);

/** A password account, signed in to nowhere yet. */
const passwordUser = async (fields: Partial<User>) => {
  const user = new User({
    avatar: '',
    permissions: Permission.REQUEST,
    userType: UserType.LOCAL,
    ...fields,
  });
  await user.setPassword('test1234');
  return getRepository(User).save(user);
};

describe('signing in with Plex', () => {
  beforeEach(() => {
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.PLEX;
    settings.main.mediaServerLogin = true;
    settings.main.newPlexLogin = true;
    plexAccount = { id: 3000, email: 'plexfriend@example.com' };
    plexShared = true;
  });

  const plexSignIn = () =>
    request(app).post('/auth/plex').send({ authToken: 'plex-token' });

  it('never hands a password account to a Plex account with its email', async () => {
    // Anyone can type a Plex friend's email into their own profile.
    const mallory = await passwordUser({
      email: 'plexfriend@example.com',
      username: 'mallory',
    });

    const res = await plexSignIn();

    assert.strictEqual(res.status, 403);
    const after = await getRepository(User).findOneOrFail({
      where: { id: mallory.id },
    });
    assert.strictEqual(after.plexId, null);
    assert.strictEqual(after.userType, UserType.LOCAL);
    assert.strictEqual(after.username, 'mallory');
  });

  it('never moves an account linked to one Plex account to another', async () => {
    const linked = await getRepository(User).save(
      new User({
        email: 'plexfriend@example.com',
        plexId: 4000,
        plexUsername: 'someoneelse',
        avatar: '',
        userType: UserType.PLEX,
      })
    );

    assert.strictEqual((await plexSignIn()).status, 403);
    const after = await getRepository(User).findOneOrFail({
      where: { id: linked.id },
    });
    assert.strictEqual(after.plexId, 4000);
  });

  it('signs in a Plex user an admin imported', async () => {
    const imported = await getRepository(User).save(
      new User({
        email: 'plexfriend@example.com',
        plexId: 3000,
        plexUsername: 'plexfriend',
        avatar: '',
        userType: UserType.PLEX,
      })
    );

    const res = await plexSignIn();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, imported.id);
  });

  it('signs in an imported Plex user whose Plex email changed', async () => {
    const imported = await getRepository(User).save(
      new User({
        email: 'old@example.com',
        plexId: 3000,
        plexUsername: 'plexfriend',
        avatar: '',
        userType: UserType.PLEX,
      })
    );

    const res = await plexSignIn();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, imported.id);
    const after = await getRepository(User).findOneOrFail({
      where: { id: imported.id },
    });
    assert.strictEqual(after.email, 'plexfriend@example.com');
  });

  it('links a Plex user added by email to their Plex account', async () => {
    const waiting = await getRepository(User).save(
      new User({
        email: 'plexfriend@example.com',
        avatar: '',
        userType: UserType.PLEX,
      })
    );

    const res = await plexSignIn();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, waiting.id);
    const after = await getRepository(User).findOneOrFail({
      where: { id: waiting.id },
    });
    assert.strictEqual(after.plexId, 3000);
  });

  it('still makes new accounts for new Plex friends', async () => {
    const res = await plexSignIn();
    assert.strictEqual(res.status, 200);
    const created = await getRepository(User).findOneOrFail({
      where: { plexId: 3000 },
    });
    assert.strictEqual(created.email, 'plexfriend@example.com');
  });
});

describe('Quick Connect while Jellyfin sign-in is turned off', () => {
  beforeEach(() => {
    configureJellyfin();
    authenticateQCMock.mock.resetCalls();
    initiateQCMock.mock.resetCalls();
    initiateQCMock.mock.mockImplementation(async () => ({
      ...defaultInitiateResponse,
    }));
    getSettings().main.mediaServerLogin = false;
  });

  it('does not sign anyone in', async () => {
    await getRepository(User).save(
      new User({
        email: 'existing-qc@seerr.dev',
        jellyfinUsername: 'quickconnectuser',
        jellyfinUserId: 'jf-qc-user-001',
        avatar: '',
        userType: UserType.JELLYFIN,
      })
    );
    try {
      const agent = request.agent(app);
      const res = await agent
        .post('/auth/jellyfin/quickconnect/authenticate')
        .send({ secret: 'abc123def456abc123def456' });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(authenticateQCMock.mock.callCount(), 0);
      assert.strictEqual((await agent.get('/auth/me')).status, 403);
    } finally {
      getSettings().main.mediaServerLogin = true;
    }
  });

  it('is only started by someone signed in, to link their account', async () => {
    try {
      const signedOut = await request(app).post(
        '/auth/jellyfin/quickconnect/initiate'
      );
      assert.strictEqual(signedOut.status, 403);
      assert.strictEqual(initiateQCMock.mock.callCount(), 0);

      const agent = await authenticatedAgent('friend@seerr.dev', 'test1234');
      const signedIn = await agent.post('/auth/jellyfin/quickconnect/initiate');
      assert.strictEqual(signedIn.status, 200);
    } finally {
      getSettings().main.mediaServerLogin = true;
    }
  });
});

describe('guessing passwords', () => {
  beforeEach(() => {
    getSettings().main.localLogin = true;
    emailMock.resetCalls();
  });

  it('stops after ten wrong passwords for one account, even the right one', async () => {
    await passwordUser({ email: 'guessed@seerr.dev', username: 'guessed' });
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/auth/local')
        .send({ email: 'guessed@seerr.dev', password: `wrong-${i}` });
      assert.strictEqual(res.status, 403);
    }

    const blocked = await request(app)
      .post('/auth/local')
      .send({ email: 'Guessed@seerr.dev', password: 'test1234' });
    assert.strictEqual(blocked.status, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 0);

    // Other accounts are not held up.
    const other = await request(app)
      .post('/auth/local')
      .send({ email: 'friend@seerr.dev', password: 'test1234' });
    assert.strictEqual(other.status, 200);
  });

  it('starts counting again after a successful sign-in', async () => {
    await passwordUser({ email: 'forgetful@seerr.dev', username: 'forgetful' });
    const attempt = (password: string) =>
      request(app)
        .post('/auth/local')
        .send({ email: 'forgetful@seerr.dev', password });

    for (let i = 0; i < 9; i++) {
      assert.strictEqual((await attempt('wrong')).status, 403);
    }
    assert.strictEqual((await attempt('test1234')).status, 200);
    for (let i = 0; i < 9; i++) {
      assert.strictEqual((await attempt('wrong')).status, 403);
    }
    assert.strictEqual((await attempt('test1234')).status, 200);
  });

  it('stops after ten wrong Jellyfin passwords', async () => {
    configureJellyfin();
    getSettings().main.mediaServerLogin = true;
    const login = mock.method(JellyfinAPI.prototype, 'login', async () => {
      throw new ApiError(401, ApiErrorCode.InvalidCredentials);
    });
    try {
      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post('/auth/jellyfin')
          .send({ username: 'jfguessed', password: `wrong-${i}` });
        assert.strictEqual(res.status, 401);
      }
      const blocked = await request(app)
        .post('/auth/jellyfin')
        .send({ username: 'JFGuessed', password: 'right' });
      assert.strictEqual(blocked.status, 429);
      assert.strictEqual(login.mock.callCount(), 10);
    } finally {
      login.mock.restore();
    }
  });

  it('sends at most ten reset emails in a row for one address', async () => {
    await passwordUser({ email: 'resetting@seerr.dev', username: 'resetting' });
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/auth/reset-password')
        .send({ email: 'resetting@seerr.dev' });
      assert.strictEqual(res.status, 200);
    }
    const blocked = await request(app)
      .post('/auth/reset-password')
      .send({ email: 'resetting@seerr.dev' });
    assert.strictEqual(blocked.status, 429);
    assert.strictEqual(emailMock.callCount(), 10);
  });

  it('answers a reset request without waiting for the email to go', async () => {
    await passwordUser({ email: 'slowmail@seerr.dev', username: 'slowmail' });
    // A mail server that never answers.
    emailMock.mockImplementationOnce(() => new Promise<undefined>(() => {}));

    const res = await request(app)
      .post('/auth/reset-password')
      .send({ email: 'slowmail@seerr.dev' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(emailMock.callCount(), 1);
  });
});

describe('signing in with a password, for someone the media server dropped', () => {
  beforeEach(() => {
    getSettings().main.localLogin = true;
    getSettings().plex.machineId = 'machine-1';
    plexShared = true;
    plexDown = false;
    jellyfinAccountMock.mock.mockImplementation(async () => ({
      Policy: { IsDisabled: false },
    }));
  });

  it('refuses a Plex friend the owner no longer shares with', async () => {
    await getRepository(User).update(
      { email: 'friend@seerr.dev' },
      { plexId: 2000 }
    );
    const signIn = () =>
      request(app)
        .post('/auth/local')
        .send({ email: 'friend@seerr.dev', password: 'test1234' });

    assert.strictEqual((await signIn()).status, 200);
    plexShared = false;
    const refused = await signIn();
    assert.strictEqual(refused.status, 403);
    assert.strictEqual(refused.body.message, 'Access denied.');

    // Plex not answering is no answer: the password is the way in then.
    plexDown = true;
    assert.strictEqual((await signIn()).status, 200);
  });

  it('refuses a Jellyfin account that was switched off or deleted', async () => {
    configureJellyfin();
    getSettings().jellyfin.apiKey = 'api-key';
    await passwordUser({
      email: 'jfuser@seerr.dev',
      jellyfinUserId: 'jf-user-9',
      jellyfinUsername: 'jfuser',
      userType: UserType.JELLYFIN,
    });
    const signIn = () =>
      request(app)
        .post('/auth/local')
        .send({ email: 'jfuser@seerr.dev', password: 'test1234' });

    assert.strictEqual((await signIn()).status, 200);
    jellyfinAccountMock.mock.mockImplementation(async () => ({
      Policy: { IsDisabled: true },
    }));
    assert.strictEqual((await signIn()).status, 403);
    jellyfinAccountMock.mock.mockImplementation(async () => undefined);
    assert.strictEqual((await signIn()).status, 403);
    // Jellyfin down: the password still works.
    jellyfinAccountMock.mock.mockImplementation(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    assert.strictEqual((await signIn()).status, 200);
  });

  it('always lets the owner in, and password accounts, with Plex sign-in off', async () => {
    plexShared = false;
    getSettings().main.mediaServerLogin = false;
    try {
      await passwordUser({ email: 'local@seerr.dev', username: 'local' });
      for (const email of ['admin@seerr.dev', 'local@seerr.dev']) {
        const res = await request(app)
          .post('/auth/local')
          .send({ email, password: 'test1234' });
        assert.strictEqual(res.status, 200, email);
      }
    } finally {
      getSettings().main.mediaServerLogin = true;
    }
  });
});

describe('waiting on Jellyfin', () => {
  it('gives up on removing the device at sign-out after a few seconds', async () => {
    configureJellyfin();
    const del = mock.method(axios, 'delete', async () => ({ status: 204 }));
    try {
      await passwordUser({
        email: 'leaving@seerr.dev',
        jellyfinUserId: 'jf-user-10',
        jellyfinDeviceId: 'device-10',
        userType: UserType.LOCAL,
      });
      const agent = await authenticatedAgent('leaving@seerr.dev', 'test1234');
      assert.strictEqual((await agent.post('/auth/logout')).status, 200);
      assert.strictEqual(del.mock.callCount(), 1);
      const config = del.mock.calls[0].arguments[1] as { timeout?: number };
      assert.strictEqual(config.timeout, 5000);
    } finally {
      del.mock.restore();
    }
  });

  it('gives up on checking the avatar at sign-in after a few seconds', async () => {
    configureJellyfin();
    authenticateQCMock.mock.mockImplementation(async () => ({
      ...defaultAuthenticateResponse,
    }));
    axiosHeadMock.mock.resetCalls();
    await getRepository(User).save(
      new User({
        email: 'avatar-qc@seerr.dev',
        jellyfinUsername: 'quickconnectuser',
        jellyfinUserId: 'jf-qc-user-001',
        avatar: '',
        userType: UserType.JELLYFIN,
      })
    );

    const res = await request(app)
      .post('/auth/jellyfin/quickconnect/authenticate')
      .send({ secret: 'abc123def456abc123def456' });
    assert.strictEqual(res.status, 200);
    assert.ok(axiosHeadMock.mock.callCount() > 0);
    const config = axiosHeadMock.mock.calls[0].arguments[1] as
      | { timeout?: number }
      | undefined;
    assert.strictEqual(config?.timeout, 5000);
  });
});
