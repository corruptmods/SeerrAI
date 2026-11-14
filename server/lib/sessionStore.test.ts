import { getRepository } from '@server/datasource';
import { Session } from '@server/entity/Session';
import { renewEvery, sessionStoreFor } from '@server/lib/sessionStore';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, describe, it, mock } from 'node:test';
import type { Repository } from 'typeorm';
import { MoreThan } from 'typeorm';

setupTestDb();

/*
 * Postgres briefly out of connections fails one session write. Sign-ins must
 * keep working afterwards instead of the store marking itself gone for good.
 */

let server: Server | undefined;

after(() => {
  server?.closeAllConnections();
  server?.close();
});

afterEach(() => mock.restoreAll());

describe('the session store', () => {
  it('keeps working after one failed write', async () => {
    const repository = getRepository(Session);
    const app = express();
    app.use(
      session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
        store: sessionStoreFor(repository),
      })
    );
    app.post('/sign-in', (req, res) => {
      if (!req.session) {
        res.status(503).json({ problem: 'no session' });
        return;
      }
      (req.session as unknown as { signedIn: boolean }).signedIn = true;
      req.session.save((error) =>
        error ? res.status(500).json({ problem: 'save failed' }) : res.json({})
      );
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sign-in`;

    const insert = repository.insert.bind(repository);
    let failed = false;
    mock.method(repository, 'insert', async (...args: unknown[]) => {
      if (!failed) {
        failed = true;
        throw new Error('sorry, too many clients already');
      }
      return insert(...(args as Parameters<typeof insert>));
    });

    assert.equal((await fetch(url, { method: 'POST' })).status, 500);
    const again = await fetch(url, { method: 'POST' });
    assert.equal(again.status, 200, JSON.stringify(await again.json()));
    assert.match(again.headers.get('set-cookie') ?? '', /connect\.sid=/);
    mock.restoreAll();
  });
});

const DAY_SECONDS = 60 * 60 * 24;

/** A server with sign-in, sign-out and a plain page, on a fresh store. */
const startSessions = async () => {
  server?.closeAllConnections();
  server?.close();
  const repository = getRepository(Session);
  const app = express();
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 1000 * DAY_SECONDS * 30 },
      store: sessionStoreFor(repository),
    })
  );
  app.post('/sign-in', (req, res) => {
    req.session.userId = 1;
    req.session.save(() => res.json({}));
  });
  app.post('/challenge', (req, res) => {
    (req.session as unknown as { challenge: string }).challenge = 'abc';
    req.session.save(() => res.json({}));
  });
  app.get('/page', (req, res) => res.json({ userId: req.session.userId }));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { repository, base };
};

const cookieFrom = (response: Response): string =>
  (response.headers.get('set-cookie') ?? '').split(';')[0];

/** Expiry writes: express-session's touch, an update with no alias. */
const countRenewals = (repository: Repository<Session>) => {
  const counted = { renewals: 0 };
  const createQueryBuilder = repository.createQueryBuilder.bind(repository);
  mock.method(repository, 'createQueryBuilder', (...args: unknown[]) => {
    if (args.length === 0) {
      counted.renewals += 1;
    }
    return createQueryBuilder(...(args as [string]));
  });
  return counted;
};

describe('renewing session expiry', () => {
  it('waits a tenth of the lifetime, at most five minutes', () => {
    assert.equal(renewEvery(30 * DAY_SECONDS), 5 * 60 * 1000);
    assert.equal(renewEvery(10 * 60), 60 * 1000);
  });

  it('writes once for a burst of requests', async () => {
    const signIn = await startSessions();
    const cookie = cookieFrom(
      await fetch(`${signIn.base}/sign-in`, { method: 'POST' })
    );
    // As after a restart: nothing remembered about the session.
    const { repository, base } = await startSessions();
    const counted = countRenewals(repository);

    const answers = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`${base}/page`, { headers: { cookie } })
      )
    );
    for (const answer of answers) {
      assert.deepEqual(await answer.json(), { userId: 1 });
    }
    assert.equal(counted.renewals, 1);

    // The next request, too soon after, writes nothing.
    await fetch(`${base}/page`, { headers: { cookie } });
    assert.equal(counted.renewals, 1);
  });

  it('renews again once the gap has passed', async () => {
    const { repository, base } = await startSessions();
    let now = Date.now();
    mock.method(Date, 'now', () => now);
    const cookie = cookieFrom(
      await fetch(`${base}/sign-in`, { method: 'POST' })
    );
    const counted = countRenewals(repository);

    now += 4 * 60 * 1000;
    await fetch(`${base}/page`, { headers: { cookie } });
    assert.equal(counted.renewals, 0);

    now += 2 * 60 * 1000;
    await fetch(`${base}/page`, { headers: { cookie } });
    await fetch(`${base}/page`, { headers: { cookie } });
    assert.equal(counted.renewals, 1);
  });

  it('never ends a session sooner than its lifetime after its last use', async () => {
    const { repository, base } = await startSessions();
    let now = Date.now();
    mock.method(Date, 'now', () => now);
    const cookie = cookieFrom(
      await fetch(`${base}/sign-in`, { method: 'POST' })
    );

    // Used just before a renewal is due, which is skipped.
    now += renewEvery(30 * DAY_SECONDS) - 1000;
    const lastUse = now;
    await fetch(`${base}/page`, { headers: { cookie } });

    const [stored] = await repository.find();
    assert.ok(Number(stored.expiredAt) >= lastUse + 30 * DAY_SECONDS * 1000);

    // Still signed in at the end of that lifetime.
    now = lastUse + 30 * DAY_SECONDS * 1000 - 1000;
    assert.deepEqual(
      await (await fetch(`${base}/page`, { headers: { cookie } })).json(),
      { userId: 1 }
    );
  });

  it('renews a signed-out session every minute and lets it lapse soon after ten unused', async () => {
    const { repository, base } = await startSessions();
    let now = Date.now();
    mock.method(Date, 'now', () => now);
    const cookie = cookieFrom(
      await fetch(`${base}/challenge`, { method: 'POST' })
    );
    const counted = countRenewals(repository);

    now += 30 * 1000;
    await fetch(`${base}/page`, { headers: { cookie } });
    assert.equal(counted.renewals, 0);

    now += 40 * 1000;
    await fetch(`${base}/page`, { headers: { cookie } });
    assert.equal(counted.renewals, 1);
    const renewedAt = now;

    // Unused for longer than its lifetime plus the gap: gone.
    now = renewedAt + (10 + 1) * 60 * 1000 + 1000;
    assert.equal(
      await repository.count({
        where: { expiredAt: MoreThan(now) },
      }),
      0
    );
  });
});
