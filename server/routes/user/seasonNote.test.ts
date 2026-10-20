import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { getRepository } from '@server/datasource';
import { UserSettings } from '@server/entity/UserSettings';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import userRoutes from '.';

/*
 * The answer to a seasonal theme's note (Keep or Turn off), kept with the
 * account so it holds on every device and the note is not asked again.
 */

let app: Express;

before(() => {
  app = express();
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );
});

setupTestDb();

const loginAs = async (email: string) => {
  getSettings().main.localLogin = true;
  const agent = request.agent(app);
  const res = await agent
    .post('/auth/local')
    .send({ email, password: 'test1234' });
  assert.equal(res.status, 200);
  return { agent, userId: res.body.id as number };
};

describe('the answer to a season’s note', () => {
  it('is nothing until they answer', async () => {
    const { agent } = await loginAs('friend@seerr.dev');
    const me = (await agent.get('/auth/me')).body;
    assert.equal(me.settings?.seasonNote ?? null, null);
  });

  it('is kept with their account and given back with them', async () => {
    const { agent, userId } = await loginAs('friend@seerr.dev');
    const off = await agent
      .post(`/user/${userId}/settings/appearance/season`)
      .send({ season: 'halloween-2026', choice: 'off' });
    assert.equal(off.status, 200);
    assert.deepEqual(off.body, { seasonNote: 'halloween-2026:off' });
    assert.equal(
      (await agent.get('/auth/me')).body.settings.seasonNote,
      'halloween-2026:off'
    );

    // A later answer replaces it, and nothing else of theirs changes.
    await agent.post(`/user/${userId}/settings/appearance`).send({
      appearance: { mode: 'light', accent: 'teal', background: 'classic' },
    });
    const keep = await agent
      .post(`/user/${userId}/settings/appearance/season`)
      .send({ season: 'holidays-2026', choice: 'keep' });
    assert.equal(keep.status, 200);
    const stored = await getRepository(UserSettings).findOneOrFail({
      where: { user: { id: userId } },
    });
    assert.equal(stored.seasonNote, 'holidays-2026:keep');
    assert.equal(stored.appearance?.accent, 'teal');
  });

  it('is only theirs to give', async () => {
    const { agent } = await loginAs('friend@seerr.dev');
    const res = await agent
      .post('/user/1/settings/appearance/season')
      .send({ season: 'halloween-2026', choice: 'off' });
    assert.equal(res.status, 403);
    const admin = await getRepository(UserSettings).findOne({
      where: { user: { id: 1 } },
    });
    assert.equal(admin?.seasonNote ?? null, null);
  });

  it('is refused when it is not a season and an answer', async () => {
    const { agent, userId } = await loginAs('friend@seerr.dev');
    for (const body of [
      {},
      { season: 'halloween-2026' },
      { season: 'halloween-2026', choice: 'maybe' },
      { season: 'easter-2026', choice: 'off' },
      // Seasons there are no longer.
      { season: 'diwali-2026', choice: 'off' },
      { season: 'pride-2026', choice: 'keep' },
      { season: 'halloween', choice: 'off' },
      { season: 'halloween-2026:off', choice: 'off' },
      { season: 'halloween-2026', choice: 'off', extra: 1 },
    ]) {
      const res = await agent
        .post(`/user/${userId}/settings/appearance/season`)
        .send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });
});
