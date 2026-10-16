import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import { oidcCallbackUrl } from '@server/constants/oidc';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import OidcLink from '@server/entity/OidcLink';
import { User } from '@server/entity/User';
import {
  CORRELATION_COOKIE,
  forgetDiscovery,
  openCorrelation,
  sealCorrelation,
} from '@server/lib/oidc';
import { Permission } from '@server/lib/permissions';
import type { OidcProviderSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import routes from '@server/routes';
import { setupTestDb } from '@server/test/db';
import type { FakeOidcAccount } from '@server/test/fakeOidcProvider';
import { createFakeOidcProvider } from '@server/test/fakeOidcProvider';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import path from 'node:path';
import request from 'supertest';

/*
 * Signing in and linking through a single sign-on provider, end to end: the
 * app as production assembles it (cookie parser, sessions, the OpenAPI
 * validator, the real routers) against a provider on localhost that issues
 * real codes and signed ID tokens, through the real openid-client.
 */

setupTestDb();

const fake = createFakeOidcProvider();
const APP_URL = 'https://seerr.example';
let app: Express;

before(async () => {
  await fake.start();
  app = express();
  // Lets the test that runs into the sign-in limit do so from an address
  // of its own, so the rest are not held up by it.
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api',
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax' },
    })
  );
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
    })
  );
  app.use('/api/v1', routes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // Express tells an error handler by its four parameters.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
});

after(async () => {
  await fake.stop();
});

const provider = (
  overrides: Partial<OidcProviderSettings> = {}
): OidcProviderSettings => ({
  id: 'authentik',
  name: 'Authentik',
  issuerUrl: fake.issuer,
  clientId: fake.clientId,
  clientSecret: fake.clientSecret,
  logoUrl: '',
  scopes: 'openid profile email',
  enabled: true,
  newUserSignUp: false,
  requiredClaims: [],
  ...overrides,
});

const setProvider = (overrides: Partial<OidcProviderSettings> = {}) => {
  getSettings().oidc = { providers: [provider(overrides)] };
};

beforeEach(() => {
  fake.reset();
  forgetDiscovery();
  const settings = getSettings();
  settings.main.applicationUrl = APP_URL;
  settings.main.localLogin = true;
  settings.main.defaultPermissions = Permission.REQUEST;
  setProvider();
});

/** The cookies a response set, as name=value pairs to send back. */
const cookiesOf = (res: request.Response): Record<string, string> => {
  const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return Object.fromEntries(
    set.map((line) => {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)];
    })
  );
};

const cookieHeader = (cookies: Record<string, string>) =>
  Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

/** Where the page the callback answers with moves on to. */
const destinationOf = (res: request.Response): URL => {
  const match = /http-equiv="refresh" content="0;url=([^"]+)"/.exec(res.text);
  assert.ok(match, `not a page that moves on: ${res.status} ${res.text}`);
  return new URL(match[1].replace(/&amp;/g, '&'), APP_URL);
};

const signInWithPassword = async (email: string) => {
  const res = await request(app)
    .post('/api/v1/auth/local')
    .send({ email, password: 'test1234' });
  assert.equal(res.status, 200);
  return cookiesOf(res);
};

interface FlowOptions {
  /** The sign-in or link route; sign-in by default. */
  start?: string;
  /** Cookies the browser already has (a session). */
  cookies?: Record<string, string>;
  tamper?: { nonce?: string; state?: string };
  /** Changes the correlation cookie before it comes back. */
  correlation?: (value: string) => string | undefined;
  /** The address the browser comes from. */
  from?: string;
}

/**
 * The browser's whole trip: to Seerr's start route, on to the provider,
 * signed in there as `account`, and back to Seerr's callback.
 */
const goThrough = async (
  account: FakeOidcAccount,
  {
    start = '/api/v1/auth/oidc/authentik/sign-in',
    cookies = {},
    tamper,
    correlation,
    from = '127.0.0.1',
  }: FlowOptions = {}
) => {
  const started = await request(app)
    .get(start)
    .set('X-Forwarded-For', from)
    .set('Cookie', cookieHeader(cookies));
  assert.equal(started.status, 302, started.text);
  const set = cookiesOf(started);
  const back = await fake.authorize(started.headers.location, account, tamper);

  const sent = { ...cookies };
  const value = correlation
    ? correlation(set[CORRELATION_COOKIE])
    : set[CORRELATION_COOKIE];
  if (value !== undefined) {
    sent[CORRELATION_COOKIE] = value;
  }
  assert.equal(back.origin, APP_URL);
  const callback = await request(app)
    .get(back.pathname + back.search)
    .set('X-Forwarded-For', from)
    .set('Cookie', cookieHeader(sent));
  assert.equal(callback.status, 200, callback.text);

  return {
    started,
    callback,
    destination: destinationOf(callback),
    cookies: { ...sent, ...cookiesOf(callback) },
  };
};

/** Who the cookies sign in as, if anyone. */
const signedInAs = async (cookies: Record<string, string>) => {
  const res = await request(app)
    .get('/api/v1/auth/me')
    .set('Cookie', cookieHeader(cookies));
  return res.status === 200 ? (res.body.id as number) : undefined;
};

const linkSub = async (
  email: string,
  sub: string,
  providerId = 'authentik'
) => {
  const user = await getRepository(User).findOneOrFail({ where: { email } });
  await getRepository(OidcLink).save(
    new OidcLink({ user, provider: providerId, sub })
  );
  return user;
};

const ALICE: FakeOidcAccount = {
  sub: 'alice-sub',
  email: 'alice@example.com',
  email_verified: true,
  name: 'Alice Example',
  preferred_username: 'alice',
};

describe('signing in with a provider', () => {
  it('signs in the account linked to that provider account, and goes on where asked', async () => {
    const friend = await linkSub('friend@seerr.dev', ALICE.sub);

    const { destination, cookies } = await goThrough(ALICE, {
      start: '/api/v1/auth/oidc/authentik/sign-in?redirect=%2Fmovie%2F603',
    });

    assert.equal(destination.pathname + destination.search, '/movie/603');
    assert.equal(await signedInAs(cookies), friend.id);
    const link = await getRepository(OidcLink).findOneByOrFail({
      sub: ALICE.sub,
    });
    assert.equal(link.username, 'alice');
  });

  it('sends the browser to the provider with PKCE, state and nonce, to the registered address', async () => {
    const started = await request(app).get(
      '/api/v1/auth/oidc/authentik/sign-in'
    );
    const to = new URL(started.headers.location);

    assert.equal(to.origin + to.pathname, `${fake.issuer}/authorize`);
    assert.equal(
      to.searchParams.get('redirect_uri'),
      oidcCallbackUrl(APP_URL, 'authentik')
    );
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(to.searchParams.get('code_challenge'));
    assert.ok(to.searchParams.get('state'));
    assert.ok(to.searchParams.get('nonce'));
    assert.equal(to.searchParams.get('scope'), 'openid profile email');
  });

  it('keeps what ties the trip together in a short-lived, signed, httpOnly, Lax cookie, cleared on the way back', async () => {
    const { started, callback } = await goThrough(ALICE);

    const set = ([] as string[]).concat(started.headers['set-cookie']);
    const line = set.find((l) => l.startsWith(`${CORRELATION_COOKIE}=`));
    assert.ok(line);
    assert.match(line, /HttpOnly/);
    assert.match(line, /SameSite=Lax/);
    assert.match(line, /Secure/, 'Secure, as the Application URL is https');
    assert.match(line, /Path=\/api\/v1\/auth\/oidc/);
    assert.match(line, /Max-Age=600/);

    const cleared = ([] as string[])
      .concat(callback.headers['set-cookie'])
      .find((l) => l.startsWith(`${CORRELATION_COOKIE}=`));
    assert.ok(cleared);
    assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
    // Its contents say nothing a page could use: it is httpOnly anyway,
    // and only good with its signature.
    assert.equal(callback.headers['cache-control'], 'no-store');
    assert.equal(callback.headers['referrer-policy'], 'no-referrer');
  });

  it('is not Secure when Seerr is on plain http', async () => {
    getSettings().main.applicationUrl = 'http://192.168.1.10:5055';
    const started = await request(app).get(
      '/api/v1/auth/oidc/authentik/sign-in'
    );
    const line = ([] as string[])
      .concat(started.headers['set-cookie'])
      .find((l) => l.startsWith(`${CORRELATION_COOKIE}=`));
    assert.ok(line);
    assert.doesNotMatch(line, /Secure/);
  });

  it('refuses a provider account nobody is linked to, while sign-up is off', async () => {
    const before = await getRepository(User).count();

    const { destination, cookies } = await goThrough(ALICE);

    assert.equal(destination.pathname, '/login');
    assert.equal(destination.searchParams.get('sso'), 'no-account');
    assert.equal(destination.searchParams.get('provider'), 'authentik');
    assert.equal(await signedInAs(cookies), undefined);
    assert.equal(await getRepository(User).count(), before);
  });

  it('makes a new account when sign-up is on, as for any new person', async () => {
    setProvider({ newUserSignUp: true });

    const { destination, cookies } = await goThrough(ALICE);

    assert.equal(destination.pathname, '/');
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'alice@example.com' },
    });
    assert.equal(await signedInAs(cookies), user.id);
    assert.equal(user.userType, UserType.LOCAL);
    assert.equal(user.permissions, Permission.REQUEST);
    assert.equal(user.displayName, 'Alice Example');
    assert.equal(user.movieQuotaLimit, null);
    const link = await getRepository(OidcLink).findOneOrFail({
      where: { sub: ALICE.sub },
      relations: { user: true },
    });
    assert.equal(link.user.id, user.id);
    assert.equal(link.provider, 'authentik');
  });

  it('reads the name and email from userinfo when the ID token has only who it is', async () => {
    setProvider({ newUserSignUp: true });
    fake.claimsInUserinfoOnly = true;

    const { cookies } = await goThrough(ALICE);

    const user = await getRepository(User).findOneOrFail({
      where: { email: 'alice@example.com' },
    });
    assert.equal(await signedInAs(cookies), user.id);
    assert.equal(user.displayName, 'Alice Example');
  });

  it('never stores an email the provider has not verified', async () => {
    setProvider({ newUserSignUp: true });

    const { cookies } = await goThrough({
      ...ALICE,
      email: 'admin@seerr.dev',
      email_verified: false,
    });

    const id = await signedInAs(cookies);
    assert.ok(id, 'signed in with a new account');
    assert.notEqual(id, 1, 'not the owner, whose email it named');
    const user = await getRepository(User).findOneByOrFail({ id });
    assert.notEqual(user.email, 'admin@seerr.dev');
    assert.doesNotMatch(user.email, /@/);
    assert.match(user.email, /^authentik:/);
  });

  it('refuses an email someone here already has, and never merges by it', async () => {
    setProvider({ newUserSignUp: true });
    const before = await getRepository(User).count();

    const { destination, cookies } = await goThrough({
      ...ALICE,
      email: 'Friend@Seerr.dev',
    });

    assert.equal(destination.searchParams.get('sso'), 'existing-account');
    assert.equal(await signedInAs(cookies), undefined);
    assert.equal(await getRepository(User).count(), before);
    assert.equal(await getRepository(OidcLink).count(), 0);
  });

  it('refuses a callback whose state does not match', async () => {
    await linkSub('friend@seerr.dev', ALICE.sub);

    const { destination, cookies } = await goThrough(ALICE, {
      tamper: { state: 'not-the-state' },
    });

    assert.equal(destination.searchParams.get('sso'), 'expired');
    assert.equal(await signedInAs(cookies), undefined);
    assert.equal(fake.tokenRequests.length, 0, 'no code was traded');
  });

  it('refuses a callback without its cookie (another browser)', async () => {
    await linkSub('friend@seerr.dev', ALICE.sub);

    const { destination, cookies } = await goThrough(ALICE, {
      correlation: () => undefined,
    });

    assert.equal(destination.searchParams.get('sso'), 'expired');
    assert.equal(await signedInAs(cookies), undefined);
    assert.equal(fake.tokenRequests.length, 0);
  });

  it('refuses a cookie that has run out, or was altered', async () => {
    await linkSub('friend@seerr.dev', ALICE.sub);

    const stale = await goThrough(ALICE, {
      correlation: (value) => {
        const opened = openCorrelation(value);
        assert.ok(opened);
        return sealCorrelation({ ...opened, expires: Date.now() - 1 });
      },
    });
    assert.equal(stale.destination.searchParams.get('sso'), 'expired');
    assert.equal(await signedInAs(stale.cookies), undefined);

    const altered = await goThrough(ALICE, {
      correlation: (value) => {
        const [payload] = value.split('.');
        const changed = JSON.parse(
          Buffer.from(payload, 'base64url').toString()
        );
        changed.returnTo = '/settings';
        return `${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${value.split('.')[1]}`;
      },
    });
    assert.equal(altered.destination.searchParams.get('sso'), 'expired');
    assert.equal(await signedInAs(altered.cookies), undefined);
  });

  it('refuses an ID token whose nonce does not match', async () => {
    await linkSub('friend@seerr.dev', ALICE.sub);

    const { destination, cookies } = await goThrough(ALICE, {
      tamper: { nonce: 'someone-elses-nonce' },
    });

    assert.equal(destination.searchParams.get('sso'), 'expired');
    assert.equal(await signedInAs(cookies), undefined);
  });

  it('says so when the person cancels at the provider', async () => {
    const started = await request(app).get(
      '/api/v1/auth/oidc/authentik/sign-in'
    );
    const state = new URL(started.headers.location).searchParams.get('state');
    const res = await request(app)
      .get(
        `/api/v1/auth/oidc/authentik/callback?error=access_denied&state=${state}`
      )
      .set('Cookie', cookieHeader(cookiesOf(started)));

    assert.equal(destinationOf(res).searchParams.get('sso'), 'denied');
  });

  it('cannot be used with a provider that is switched off, and its links stay', async () => {
    await linkSub('friend@seerr.dev', ALICE.sub);
    setProvider({ enabled: false });

    const started = await request(app).get(
      '/api/v1/auth/oidc/authentik/sign-in'
    );
    assert.equal(started.status, 302);
    const to = new URL(started.headers.location, APP_URL);
    assert.equal(to.pathname, '/login');
    assert.equal(to.searchParams.get('sso'), 'unavailable');

    // A trip started while it was on ends refused once it is off.
    setProvider();
    const { destination, cookies } = await goThrough(ALICE, {
      correlation: (value) => {
        setProvider({ enabled: false });
        return value;
      },
    });
    assert.equal(destination.searchParams.get('sso'), 'unavailable');
    assert.equal(await signedInAs(cookies), undefined);
    assert.equal(await getRepository(OidcLink).count(), 1);

    const publicSettings = await request(app).get('/api/v1/settings/public');
    assert.deepEqual(publicSettings.body.oidcProviders, []);
  });

  it('ends a sign-in where it was going only when that is a page on this site', async () => {
    await linkSub('friend@seerr.dev', ALICE.sub);

    for (const unsafe of [
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      '/login',
    ]) {
      const { destination } = await goThrough(ALICE, {
        start: `/api/v1/auth/oidc/authentik/sign-in?redirect=${encodeURIComponent(unsafe)}`,
      });
      assert.equal(destination.origin, APP_URL, unsafe);
      assert.equal(destination.pathname, '/', unsafe);
    }
  });

  it('needs the Application URL', async () => {
    getSettings().main.applicationUrl = '';

    const started = await request(app).get(
      '/api/v1/auth/oidc/authentik/sign-in'
    );

    assert.equal(
      new URL(started.headers.location, APP_URL).searchParams.get('sso'),
      'unavailable'
    );
  });

  it('asks the provider about itself once in a while, not on every sign-in', async () => {
    await linkSub('friend@seerr.dev', ALICE.sub);

    await goThrough(ALICE);
    await goThrough(ALICE);

    assert.equal(fake.discoveryCalls, 1);
  });

  it('slows down someone whose sign-ins keep failing', async () => {
    const from = '203.0.113.9';
    await linkSub('friend@seerr.dev', ALICE.sub);
    for (let i = 0; i < 10; i++) {
      const { destination } = await goThrough(ALICE, {
        from,
        tamper: { nonce: 'other' },
      });
      assert.equal(destination.searchParams.get('sso'), 'expired');
    }

    const blocked = await goThrough(ALICE, { from });
    assert.equal(blocked.destination.searchParams.get('sso'), 'too-many');
    assert.equal(await signedInAs(blocked.cookies), undefined);

    // Someone signing in from elsewhere is not held up.
    const elsewhere = await goThrough(ALICE);
    assert.ok(await signedInAs(elsewhere.cookies));
  });

  it('never holds anyone up over callbacks no sign-in here started', async () => {
    // Behind a proxy Seerr does not trust, everyone has the same address:
    // callbacks made up by someone else must not lock them all out.
    const from = '203.0.113.10';
    for (let i = 0; i < 12; i++) {
      for (const providerId of ['authentik', `made-up-${i}`]) {
        const res = await request(app)
          .get(`/api/v1/auth/oidc/${providerId}/callback?code=x&state=y`)
          .set('X-Forwarded-For', from);
        assert.notEqual(destinationOf(res).searchParams.get('sso'), 'too-many');
      }
    }
    // Nor a genuine cookie from a sign-in with another provider.
    const elsewhere = sealCorrelation({
      provider: 'google',
      state: 's',
      verifier: 'v',
      nonce: 'n',
      returnTo: '/',
      expires: Date.now() + 60_000,
    });
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .get('/api/v1/auth/oidc/authentik/callback?code=x&state=s')
        .set('X-Forwarded-For', from)
        .set('Cookie', `${CORRELATION_COOKIE}=${elsewhere}`);
      assert.equal(destinationOf(res).searchParams.get('sso'), 'expired');
    }
    await linkSub('friend@seerr.dev', ALICE.sub);

    const { destination, cookies } = await goThrough(ALICE, { from });

    assert.equal(destination.pathname, '/');
    assert.ok(await signedInAs(cookies));
  });

  it('never writes a code, token or secret to the log', async () => {
    await linkSub('friend@seerr.dev', ALICE.sub);
    const written: unknown[] = [];
    const methods = ['info', 'warn', 'error', 'debug'] as const;
    const mocks = methods.map((method) =>
      mock.method(logger, method, (...args: unknown[]) => {
        written.push(args);
        return logger;
      })
    );
    try {
      const ok = await goThrough(ALICE);
      const bad = await goThrough(ALICE, { tamper: { nonce: 'other' } });
      const log = JSON.stringify(written);
      for (const res of [ok, bad]) {
        const back = new URL(res.started.headers.location).searchParams.get(
          'state'
        ) as string;
        assert.ok(!log.includes(back), 'no state');
      }
      assert.ok(written.length > 0);
      assert.ok(!log.includes(fake.clientSecret), 'no client secret');
      assert.ok(!/"code"|code_verifier|access_token|id_token/.test(log));
    } finally {
      mocks.forEach((m) => m.mock.restore());
    }
  });
});

describe('who can sign in', () => {
  const refused = (destination: URL) =>
    destination.searchParams.get('sso') === 'not-allowed';

  it('lets in someone whose claim is true, as upstream does', async () => {
    const friend = await linkSub('friend@seerr.dev', ALICE.sub);
    setProvider({ requiredClaims: [{ claim: 'is_seerr_user' }] });
    fake.idTokenClaims = { is_seerr_user: true };

    const { destination, cookies } = await goThrough(ALICE);

    assert.equal(destination.pathname, '/');
    assert.equal(await signedInAs(cookies), friend.id);
  });

  it('takes the string "true" as true', async () => {
    const friend = await linkSub('friend@seerr.dev', ALICE.sub);
    setProvider({ requiredClaims: [{ claim: 'is_seerr_user' }] });
    fake.idTokenClaims = { is_seerr_user: 'true' };

    const { cookies } = await goThrough(ALICE);

    assert.equal(await signedInAs(cookies), friend.id);
  });

  it('turns away someone whose claim is missing, false or anything else', async () => {
    await linkSub('friend@seerr.dev', ALICE.sub);
    setProvider({ requiredClaims: [{ claim: 'is_seerr_user' }] });

    for (const value of [undefined, false, 'false', 1, 'yes']) {
      fake.idTokenClaims = value === undefined ? {} : { is_seerr_user: value };
      const { destination, cookies } = await goThrough(ALICE);
      assert.ok(refused(destination), `refused with ${String(value)}`);
      assert.equal(destination.pathname, '/login');
      assert.equal(destination.searchParams.get('provider'), 'authentik');
      assert.equal(await signedInAs(cookies), undefined);
    }
  });

  it('compares a value with a text claim exactly', async () => {
    const friend = await linkSub('friend@seerr.dev', ALICE.sub);
    setProvider({ requiredClaims: [{ claim: 'hd', value: 'example.com' }] });

    fake.idTokenClaims = { hd: 'example.com' };
    const allowed = await goThrough(ALICE);
    assert.equal(await signedInAs(allowed.cookies), friend.id);

    for (const hd of ['other.com', 'Example.com', 'example.com.evil']) {
      fake.idTokenClaims = { hd };
      const { destination, cookies } = await goThrough(ALICE);
      assert.ok(refused(destination), hd);
      assert.equal(await signedInAs(cookies), undefined);
    }
  });

  it('looks for a value in a list claim, such as groups', async () => {
    const friend = await linkSub('friend@seerr.dev', ALICE.sub);
    setProvider({
      requiredClaims: [{ claim: 'groups', value: 'seerr-users' }],
    });

    fake.idTokenClaims = { groups: ['admins', 'seerr-users'] };
    const allowed = await goThrough(ALICE);
    assert.equal(await signedInAs(allowed.cookies), friend.id);

    for (const groups of [[], ['admins'], ['Seerr-Users'], 'admins']) {
      fake.idTokenClaims = { groups };
      const { destination, cookies } = await goThrough(ALICE);
      assert.ok(refused(destination), JSON.stringify(groups));
      assert.equal(await signedInAs(cookies), undefined);
    }
  });

  it('needs every rule to pass', async () => {
    const friend = await linkSub('friend@seerr.dev', ALICE.sub);
    setProvider({
      requiredClaims: [
        { claim: 'groups', value: 'seerr-users' },
        { claim: 'hd', value: 'example.com' },
        { claim: 'is_seerr_user' },
      ],
    });

    fake.idTokenClaims = {
      groups: ['seerr-users'],
      hd: 'example.com',
      is_seerr_user: false,
    };
    const one = await goThrough(ALICE);
    assert.ok(refused(one.destination));
    assert.equal(await signedInAs(one.cookies), undefined);

    fake.idTokenClaims = {
      groups: ['seerr-users'],
      hd: 'example.com',
      is_seerr_user: true,
    };
    const all = await goThrough(ALICE);
    assert.equal(await signedInAs(all.cookies), friend.id);
  });

  it('sees claims the provider only gives from userinfo', async () => {
    const friend = await linkSub('friend@seerr.dev', ALICE.sub);
    setProvider({
      requiredClaims: [{ claim: 'groups', value: 'seerr-users' }],
    });
    fake.userinfoClaims = { groups: ['seerr-users'] };

    const { cookies } = await goThrough(ALICE);

    assert.equal(await signedInAs(cookies), friend.id);
  });

  it('turns everyone away when userinfo cannot be read and there are rules', async () => {
    const friend = await linkSub('friend@seerr.dev', ALICE.sub);
    setProvider({
      requiredClaims: [{ claim: 'groups', value: 'seerr-users' }],
    });
    fake.idTokenClaims = { groups: ['seerr-users'] };
    fake.userinfoDown = true;

    const refusedTrip = await goThrough(ALICE);
    assert.equal(
      refusedTrip.destination.searchParams.get('sso'),
      'provider',
      'the provider is at fault, not the person'
    );
    assert.equal(await signedInAs(refusedTrip.cookies), undefined);

    // Without rules, a linked account still signs in as before.
    setProvider();
    const { cookies } = await goThrough(ALICE);
    assert.equal(await signedInAs(cookies), friend.id);
  });

  it('makes no account for someone it turns away, even with sign-up on', async () => {
    setProvider({
      newUserSignUp: true,
      requiredClaims: [{ claim: 'groups', value: 'seerr-users' }],
    });
    fake.idTokenClaims = { groups: ['family'] };
    const users = await getRepository(User).count();

    const { destination, cookies } = await goThrough(ALICE);

    assert.ok(refused(destination));
    assert.equal(await signedInAs(cookies), undefined);
    assert.equal(await getRepository(User).count(), users);
    assert.equal(await getRepository(OidcLink).count(), 0);

    // Let in, the same person gets their account.
    fake.idTokenClaims = { groups: ['family', 'seerr-users'] };
    const allowed = await goThrough(ALICE);
    assert.ok(await signedInAs(allowed.cookies));
    assert.equal(await getRepository(User).count(), users + 1);
  });

  it('refuses to link an account it would turn away', async () => {
    setProvider({
      requiredClaims: [{ claim: 'groups', value: 'seerr-users' }],
    });
    fake.idTokenClaims = { groups: ['family'] };
    const session = await signInWithPassword('friend@seerr.dev');

    const { destination, cookies } = await goThrough(ALICE, {
      start: '/api/v1/auth/oidc/authentik/link',
      cookies: session,
    });

    assert.equal(destination.pathname, '/profile/settings/linked-accounts');
    assert.ok(refused(destination));
    assert.equal(destination.searchParams.get('provider'), 'authentik');
    assert.equal(await getRepository(OidcLink).count(), 0);
    // Still signed in as themselves.
    assert.ok(await signedInAs(cookies));
  });

  it('applies rules saved the way upstream writes them', async () => {
    const friend = await linkSub('friend@seerr.dev', ALICE.sub);
    // As pasted from upstream's settings.json: names in one string.
    getSettings().oidc = {
      providers: [
        provider({
          requiredClaims: 'is_seerr_user  other_claim' as never,
        }),
      ],
    };

    fake.idTokenClaims = { is_seerr_user: true };
    const one = await goThrough(ALICE);
    assert.ok(refused(one.destination));

    fake.idTokenClaims = { is_seerr_user: true, other_claim: true };
    const both = await goThrough(ALICE);
    assert.equal(await signedInAs(both.cookies), friend.id);
  });

  it('counts each refusal toward the sign-in limit', async () => {
    await linkSub('friend@seerr.dev', ALICE.sub);
    setProvider({ requiredClaims: [{ claim: 'is_seerr_user' }] });
    const from = '203.0.113.20';

    for (let i = 0; i < 10; i++) {
      const { destination } = await goThrough(ALICE, { from });
      assert.ok(refused(destination));
    }
    fake.idTokenClaims = { is_seerr_user: true };
    const blocked = await goThrough(ALICE, { from });
    assert.equal(blocked.destination.searchParams.get('sso'), 'too-many');
    assert.equal(await signedInAs(blocked.cookies), undefined);
  });

  it('logs which claims failed by name, never their values', async () => {
    await linkSub('friend@seerr.dev', ALICE.sub);
    setProvider({
      requiredClaims: [
        { claim: 'groups', value: 'seerr-users' },
        { claim: 'hd', value: 'example.com' },
        { claim: 'is_seerr_user' },
      ],
    });
    fake.idTokenClaims = {
      groups: ['secret-family-group'],
      hd: 'private.example',
      is_seerr_user: true,
    };
    const written: unknown[] = [];
    const methods = ['info', 'warn', 'error', 'debug'] as const;
    const mocks = methods.map((method) =>
      mock.method(logger, method, (...args: unknown[]) => {
        written.push(args);
        return logger;
      })
    );
    try {
      await goThrough(ALICE);
    } finally {
      mocks.forEach((m) => m.mock.restore());
    }
    const refusal = written.find(
      (args) =>
        (args as [string, { outcome?: string }])[1]?.outcome === 'not-allowed'
    ) as [string, Record<string, unknown>] | undefined;
    assert.ok(refusal, 'the refusal is logged');
    assert.equal(refusal[1].provider, 'authentik');
    assert.deepEqual(refusal[1].failedClaims, ['groups', 'hd']);
    const log = JSON.stringify(written);
    for (const secret of [
      'secret-family-group',
      'private.example',
      'seerr-users',
      'example.com',
    ]) {
      assert.ok(!log.includes(secret), `no ${secret}`);
    }
  });
});

describe('linking a provider account', () => {
  it('links the provider account to whoever is signed in, from their own profile', async () => {
    const session = await signInWithPassword('friend@seerr.dev');

    const { destination } = await goThrough(ALICE, {
      start: '/api/v1/auth/oidc/authentik/link',
      cookies: session,
    });

    assert.equal(destination.pathname, '/profile/settings/linked-accounts');
    assert.equal(destination.searchParams.get('sso'), 'linked');
    const link = await getRepository(OidcLink).findOneOrFail({
      where: { sub: ALICE.sub },
      relations: { user: true },
    });
    const friend = await getRepository(User).findOneByOrFail({
      email: 'friend@seerr.dev',
    });
    assert.equal(link.user.id, friend.id);

    // And from then on it signs them in.
    const { cookies } = await goThrough(ALICE);
    assert.equal(await signedInAs(cookies), friend.id);
  });

  it('refuses a provider account linked to someone else', async () => {
    await linkSub('admin@seerr.dev', ALICE.sub);
    const session = await signInWithPassword('friend@seerr.dev');

    const { destination } = await goThrough(ALICE, {
      start: '/api/v1/auth/oidc/authentik/link',
      cookies: session,
    });

    assert.equal(destination.searchParams.get('sso'), 'taken');
    const link = await getRepository(OidcLink).findOneOrFail({
      where: { sub: ALICE.sub },
      relations: { user: true },
    });
    assert.equal(link.user.id, 1);
  });

  it('refuses a second account on the same provider', async () => {
    await linkSub('friend@seerr.dev', 'another-sub');
    const session = await signInWithPassword('friend@seerr.dev');

    const { destination } = await goThrough(ALICE, {
      start: '/api/v1/auth/oidc/authentik/link',
      cookies: session,
    });

    assert.equal(destination.searchParams.get('sso'), 'already-linked');
    assert.equal(await getRepository(OidcLink).count(), 1);
  });

  it('sends someone not signed in to sign in first', async () => {
    const res = await request(app).get('/api/v1/auth/oidc/authentik/link');

    assert.equal(res.status, 302);
    assert.equal(
      res.headers.location,
      '/login?redirect=%2Fprofile%2Fsettings%2Flinked-accounts'
    );
  });
});

describe('a provider whose issuer URL changed', () => {
  const OLD_ISSUER = 'https://old-idp.example/realms/home';

  /** A link made while the provider was at another issuer. */
  const linkElsewhere = async (email: string, sub: string) => {
    const user = await getRepository(User).findOneOrFail({ where: { email } });
    await getRepository(OidcLink).save(
      new OidcLink({ user, provider: 'authentik', sub, issuer: OLD_ISSUER })
    );
    return user;
  };

  it('signs nobody in through a link made at the old issuer', async () => {
    const friend = await linkElsewhere('friend@seerr.dev', ALICE.sub);

    const { destination, cookies } = await goThrough(ALICE);

    assert.equal(destination.searchParams.get('sso'), 'no-account');
    assert.equal(await signedInAs(cookies), undefined);

    // With sign-up on, the same id at the new issuer is someone new.
    setProvider({ newUserSignUp: true });
    const again = await goThrough(ALICE);
    const id = await signedInAs(again.cookies);
    assert.ok(id);
    assert.notEqual(id, friend.id);
  });

  it('records the issuer on every new link', async () => {
    setProvider({ newUserSignUp: true });

    await goThrough(ALICE);

    const link = await getRepository(OidcLink).findOneByOrFail({
      sub: ALICE.sub,
    });
    assert.equal(link.issuer, fake.issuer);
  });

  it('gives a link from before issuers were recorded the current one when it is used', async () => {
    const friend = await linkSub('friend@seerr.dev', ALICE.sub);

    const { cookies } = await goThrough(ALICE);

    assert.equal(await signedInAs(cookies), friend.id);
    const link = await getRepository(OidcLink).findOneByOrFail({
      sub: ALICE.sub,
    });
    assert.equal(link.issuer, fake.issuer);
  });

  it('shows a link to the old issuer as not available, and lets it go', async () => {
    const friend = await linkElsewhere('friend@seerr.dev', ALICE.sub);
    await getRepository(User)
      .createQueryBuilder()
      .update()
      .set({ password: () => 'NULL' })
      .where('id = :id', { id: friend.id })
      .execute();
    const admin = await signInWithPassword('admin@seerr.dev');

    const listed = await request(app)
      .get(`/api/v1/user/${friend.id}/settings/linked-accounts/oidc`)
      .set('Cookie', cookieHeader(admin));
    assert.deepEqual(
      listed.body.map((l: { available: boolean }) => l.available),
      [false]
    );

    // It is no way in, so it is never someone's last.
    const removed = await request(app)
      .delete(
        `/api/v1/user/${friend.id}/settings/linked-accounts/oidc/authentik`
      )
      .set('Cookie', cookieHeader(admin));
    assert.equal(removed.status, 204, removed.text);
  });

  it('lets people link again, in place of their old link', async () => {
    const friend = await linkElsewhere('friend@seerr.dev', 'old-sub');
    // Someone at the old issuer had the id the new one gives Alice.
    await linkElsewhere('admin@seerr.dev', ALICE.sub);
    const session = await signInWithPassword('friend@seerr.dev');

    const { destination } = await goThrough(ALICE, {
      start: '/api/v1/auth/oidc/authentik/link',
      cookies: session,
    });

    assert.equal(destination.searchParams.get('sso'), 'linked');
    const links = await getRepository(OidcLink).find({
      relations: { user: true },
    });
    assert.deepEqual(
      links.map((l) => [l.user.id, l.sub, l.issuer]),
      [[friend.id, ALICE.sub, fake.issuer]]
    );
    const { cookies } = await goThrough(ALICE);
    assert.equal(await signedInAs(cookies), friend.id);
  });
});

describe('Linked Accounts', () => {
  const listFor = async (
    cookies: Record<string, string>,
    userId: number
  ): Promise<request.Response> =>
    request(app)
      .get(`/api/v1/user/${userId}/settings/linked-accounts/oidc`)
      .set('Cookie', cookieHeader(cookies));

  const unlink = (
    cookies: Record<string, string>,
    userId: number,
    providerId = 'authentik'
  ) =>
    request(app)
      .delete(
        `/api/v1/user/${userId}/settings/linked-accounts/oidc/${providerId}`
      )
      .set('Cookie', cookieHeader(cookies));

  it('lists links, those that cannot be used as not available', async () => {
    const friend = await linkSub('friend@seerr.dev', ALICE.sub);
    await linkSub('friend@seerr.dev', 'g-sub', 'google');
    const session = await signInWithPassword('friend@seerr.dev');

    const res = await listFor(session, friend.id);

    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((l: { provider: string; available: boolean }) => [
        l.provider,
        l.available,
      ]),
      [
        ['authentik', true],
        ['google', false],
      ]
    );
  });

  it('removes a link while a password still lets them in', async () => {
    const friend = await linkSub('friend@seerr.dev', ALICE.sub);
    const session = await signInWithPassword('friend@seerr.dev');

    const res = await unlink(session, friend.id);

    assert.equal(res.status, 204);
    assert.equal(await getRepository(OidcLink).count(), 0);
  });

  it('keeps the only way someone has to sign in', async () => {
    setProvider({ newUserSignUp: true });
    const { cookies } = await goThrough(ALICE);
    const id = (await signedInAs(cookies)) as number;

    const refused = await unlink(cookies, id);
    assert.equal(refused.status, 400);
    assert.equal(await getRepository(OidcLink).count(), 1);

    // Another provider that is switched on is another way in.
    getSettings().oidc = {
      providers: [
        provider({ newUserSignUp: true }),
        provider({ id: 'pocket' }),
      ],
    };
    await getRepository(OidcLink).save(
      new OidcLink({ user: { id } as User, provider: 'pocket', sub: 'p' })
    );
    const allowed = await unlink(cookies, id);
    assert.equal(allowed.status, 204);
  });

  it('always lets a link that cannot be used go', async () => {
    setProvider({ newUserSignUp: true });
    const { cookies } = await goThrough(ALICE);
    const id = (await signedInAs(cookies)) as number;
    await getRepository(OidcLink).save(
      new OidcLink({ user: { id } as User, provider: 'removed', sub: 'r' })
    );

    const res = await unlink(cookies, id, 'removed');

    assert.equal(res.status, 204);
  });

  it('counts a provider as a way in when a media server account is unlinked', async () => {
    // Someone with a Plex account and no password.
    const friend = await getRepository(User).findOneByOrFail({
      email: 'friend@seerr.dev',
    });
    await getRepository(User)
      .createQueryBuilder()
      .update()
      .set({ password: () => 'NULL' })
      .where('id = :id', { id: friend.id })
      .execute();
    const settings = getSettings();
    const before = settings.main.mediaServerType;
    settings.main.mediaServerType = MediaServerType.PLEX;
    try {
      const session = await signInWithPassword('admin@seerr.dev');
      const unlinkPlex = () =>
        request(app)
          .delete(`/api/v1/user/${friend.id}/settings/linked-accounts/plex`)
          .set('Cookie', cookieHeader(session));

      assert.equal((await unlinkPlex()).status, 400, 'their only way in');

      await linkSub('friend@seerr.dev', ALICE.sub);
      const res = await unlinkPlex();
      assert.equal(res.status, 204, res.text);
    } finally {
      settings.main.mediaServerType = before;
    }
  });

  it("is not someone else's to change unless they manage users", async () => {
    const admin = await getRepository(User).findOneByOrFail({ id: 1 });
    await linkSub('admin@seerr.dev', ALICE.sub);
    const session = await signInWithPassword('friend@seerr.dev');

    assert.equal((await listFor(session, admin.id)).status, 403);
    assert.equal((await unlink(session, admin.id)).status, 403);
  });
});
