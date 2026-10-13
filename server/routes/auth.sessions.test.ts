import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { Session } from '@server/entity/Session';
import { User } from '@server/entity/User';
import UserPasskey from '@server/entity/UserPasskey';
import { Permission } from '@server/lib/permissions';
import { sessionStoreFor } from '@server/lib/sessionStore';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';

/*
 * Signing out everywhere else when a password changes or a passkey goes:
 * against the real session store, where sessions are database rows.
 */

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
    // Postgres numbers new rows itself, whatever id is given.
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
