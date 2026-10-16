import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import { MEDIA_SERVER_KINDS, MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import OidcLink from '@server/entity/OidcLink';
import { User } from '@server/entity/User';
import UserPasskey from '@server/entity/UserPasskey';
import { applyMediaServerLogin } from '@server/lib/mediaServerAdmin';
import { passkeyName, takeChallenge } from '@server/lib/passkeys';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

// Settings → Users' media server sign-in switch, which turns every
// connected server's own switch on or off.
const setMediaServerLogin = (on: boolean): void => {
  getSettings().main.mediaServerLogin = on;
  applyMediaServerLogin(on);
};

/*
 * Passkeys end to end against the real verification code: a small software
 * authenticator below makes real P-256 keys and signatures, the way a phone
 * or security key would, and every request goes through the API validator
 * and a real session cookie.
 */

const RP_ID = 'seerr.test';
const ORIGIN = `https://${RP_ID}`;

// ---- a minimal software authenticator ------------------------------------

const b64url = (buf: Buffer | Uint8Array) =>
  Buffer.from(buf).toString('base64url');
const sha256 = (data: Buffer | string) =>
  crypto.createHash('sha256').update(data).digest();

/** Just enough CBOR for a COSE key and a "none" attestation object. */
const cborInt = (n: number) =>
  n >= 0 ? Buffer.from([n]) : Buffer.from([0x20 + (-1 - n)]);
const cborBytes = (b: Buffer) =>
  Buffer.concat([
    b.length < 24
      ? Buffer.from([0x40 + b.length])
      : b.length < 256
        ? Buffer.from([0x58, b.length])
        : Buffer.from([0x59, b.length >> 8, b.length & 0xff]),
    b,
  ]);
const cborText = (s: string) =>
  Buffer.concat([Buffer.from([0x60 + s.length]), Buffer.from(s)]);

class Authenticator {
  private key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  public credentialId = crypto.randomBytes(16);
  public counter = 0;
  public userHandle?: string;

  private coseKey() {
    const jwk = this.key.publicKey.export({ format: 'jwk' });
    return Buffer.concat([
      Buffer.from([0xa5]),
      cborInt(1),
      cborInt(2), // kty: EC2
      cborInt(3),
      cborInt(-7), // alg: ES256
      cborInt(-1),
      cborInt(1), // crv: P-256
      cborInt(-2),
      cborBytes(Buffer.from(jwk.x as string, 'base64url')),
      cborInt(-3),
      cborBytes(Buffer.from(jwk.y as string, 'base64url')),
    ]);
  }

  private authData(rpId: string, attested: boolean) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const flags = 0x01 | 0x04 | (attested ? 0x40 : 0); // UP, UV, AT
    const parts = [sha256(rpId), Buffer.from([flags]), counter];
    if (attested) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), idLength, this.credentialId, this.coseKey());
    }
    return Buffer.concat(parts);
  }

  public create(options: {
    challenge: string;
    user: { id: string };
    rp: { id: string };
  }) {
    this.userHandle = options.user.id;
    const clientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: options.challenge,
        origin: ORIGIN,
        crossOrigin: false,
      })
    );
    const attestation = Buffer.concat([
      Buffer.from([0xa3]),
      cborText('fmt'),
      cborText('none'),
      cborText('attStmt'),
      Buffer.from([0xa0]),
      cborText('authData'),
      cborBytes(this.authData(options.rp.id, true)),
    ]);
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        attestationObject: b64url(attestation),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  public get(
    options: { challenge: string; rpId: string },
    overrides: { origin?: string; userHandle?: string } = {}
  ) {
    this.counter += 1;
    const clientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: options.challenge,
        origin: overrides.origin ?? ORIGIN,
        crossOrigin: false,
      })
    );
    const authData = this.authData(options.rpId, false);
    const signature = crypto.sign(
      'sha256',
      Buffer.concat([authData, sha256(clientData)]),
      this.key.privateKey
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: overrides.userHandle ?? this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}

// ---- the app ----------------------------------------------------------------

let plexAccess = true;
Object.defineProperty(PlexTvAPI.prototype, 'checkUserAccess', {
  configurable: true,
  set() {},
  get() {
    return async () => plexAccess;
  },
});

setupTestDb();

let app: Server;
let port: number;

before(async () => {
  const ex = express();
  ex.set('trust proxy', true);
  ex.use(express.json());
  ex.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  // Test-only way in: signs the session in as the user named in the header.
  ex.use((req, _res, next) => {
    const as = req.header('x-test-sign-in-as');
    if (as) {
      req.session.userId = Number(as);
    }
    next();
  });
  ex.use(checkUser);
  ex.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  ex.use('/api/v1/auth', authRoutes);
  ex.use(
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
  app = await new Promise<Server>((resolve) => {
    const s = ex.listen(0, () => resolve(s));
  });
  port = (app.address() as { port: number }).port;
});
after(() => app?.close());

/** Jellyfin's answer for whether someone's account there is switched on. */
let jellyfinEnabled = true;
Object.defineProperty(JellyfinAPI.prototype, 'getAccount', {
  configurable: true,
  set() {},
  get() {
    return async () => ({ Policy: { IsDisabled: !jellyfinEnabled } });
  },
});

beforeEach(async () => {
  plexAccess = true;
  jellyfinEnabled = true;
  const settings = getSettings();
  settings.main.applicationUrl = ORIGIN;
  setMediaServerLogin(true);
  // A server set up with Plex, and nothing else connected.
  settings.main.mediaServerType = MediaServerType.PLEX;
  for (const kind of MEDIA_SERVER_KINDS) {
    settings[kind].connected = false;
    settings[kind].signIn = true;
  }
  // Both seeded accounts are Plex accounts; the friend is on the share list.
  await getRepository(User).update(
    { email: 'admin@seerr.dev' },
    {
      plexId: 1000,
    }
  );
  await getRepository(User).update(
    { email: 'friend@seerr.dev' },
    {
      plexId: 2000,
    }
  );
});

/** A browser: keeps its session cookie between calls. */
class Browser {
  public cookie = '';

  public async call(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth${url}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      this.cookie = setCookie.split(';')[0];
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  public signInAs(userId: number) {
    return this.call('GET', '/me', undefined, {
      'x-test-sign-in-as': String(userId),
    });
  }
}

const userId = async (email: string) =>
  (await getRepository(User).findOneOrFail({ where: { email } })).id;

/** Adds a passkey for whoever this browser is signed in as. */
const addPasskey = async (browser: Browser, device: Authenticator) => {
  const options = await browser.call('POST', '/passkey/register/options');
  assert.equal(options.status, 200);
  return browser.call('POST', '/passkey/register', {
    response: device.create(options.body),
  });
};

const signInWith = async (
  device: Authenticator,
  overrides?: { origin?: string; userHandle?: string }
) => {
  const browser = new Browser();
  const options = await browser.call('POST', '/passkey/login/options');
  assert.equal(options.status, 200);
  const result = await browser.call('POST', '/passkey/login', {
    response: device.get(options.body, overrides),
  });
  return { ...result, browser };
};

describe('passkeys', () => {
  it('adds several passkeys and signs in with each', async () => {
    const friend = await userId('friend@seerr.dev');
    const browser = new Browser();
    await browser.signInAs(friend);

    const phone = new Authenticator();
    const laptop = new Authenticator();
    const added = await addPasskey(browser, phone);
    assert.equal(added.status, 201);
    assert.equal((await addPasskey(browser, laptop)).status, 201);

    const list = await browser.call('GET', '/passkey');
    assert.equal(list.body.length, 2);

    for (const device of [phone, laptop]) {
      const signedIn = await signInWith(device);
      assert.equal(signedIn.status, 200);
      assert.equal(signedIn.body.id, friend);
      const me = await signedIn.browser.call('GET', '/me');
      assert.equal(me.body.id, friend, 'the session is signed in');
    }

    const stored = await getRepository(UserPasskey).findOneOrFail({
      where: { id: added.body.id },
    });
    assert.equal(Number(stored.counter), 1);
    assert.ok(stored.lastUsedAt);
  });

  it('signs in on a new session, never on one from before', async () => {
    const friend = await userId('friend@seerr.dev');
    const owner = new Browser();
    await owner.signInAs(friend);
    const device = new Authenticator();
    assert.equal((await addPasskey(owner, device)).status, 201);

    // Starting a passkey sign-in stores a session before anyone is signed
    // in; someone could note that id, or plant it in another's browser.
    const other = new Browser();
    await other.call('POST', '/passkey/login/options');
    const earlier = other.cookie;
    assert.ok(earlier);

    for (const signIn of [
      async (browser: Browser) => {
        const options = await browser.call('POST', '/passkey/login/options');
        return browser.call('POST', '/passkey/login', {
          response: device.get(options.body),
        });
      },
      (browser: Browser) =>
        browser.call('POST', '/local', {
          email: 'friend@seerr.dev',
          password: 'test1234',
        }),
    ]) {
      const browser = new Browser();
      browser.cookie = earlier;
      assert.equal((await signIn(browser)).status, 200);
      assert.notEqual(browser.cookie, earlier, 'signed in on a new session');
      assert.equal((await browser.call('GET', '/me')).body.id, friend);
      assert.equal(
        (await other.call('GET', '/me')).status,
        403,
        'the earlier session id is not signed in'
      );
    }
  });

  it('names a passkey after the device, and lets its owner rename it', async () => {
    assert.equal(
      passkeyName(
        'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4',
        'Mozilla/5.0 (Linux; Android 14)'
      ),
      'Google Password Manager'
    );
    assert.equal(
      passkeyName(
        '00000000-0000-0000-0000-000000000000',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
      ),
      'iPhone'
    );

    const browser = new Browser();
    await browser.signInAs(await userId('friend@seerr.dev'));
    const added = await addPasskey(browser, new Authenticator());
    const renamed = await browser.call('PUT', `/passkey/${added.body.id}`, {
      name: '  My   phone ',
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'My phone');
  });

  it("keeps each person's passkeys to themselves", async () => {
    const friendBrowser = new Browser();
    await friendBrowser.signInAs(await userId('friend@seerr.dev'));
    const added = await addPasskey(friendBrowser, new Authenticator());

    const admin = new Browser();
    await admin.signInAs(await userId('admin@seerr.dev'));
    assert.deepEqual((await admin.call('GET', '/passkey')).body, []);
    assert.equal(
      (await admin.call('DELETE', `/passkey/${added.body.id}`)).status,
      404
    );
    assert.equal(
      (await admin.call('PUT', `/passkey/${added.body.id}`, { name: 'x' }))
        .status,
      404
    );

    assert.equal(
      (await friendBrowser.call('DELETE', `/passkey/${added.body.id}`)).status,
      204
    );
    assert.deepEqual((await friendBrowser.call('GET', '/passkey')).body, []);
  });

  it('will not add a passkey without signing in', async () => {
    const res = await new Browser().call('POST', '/passkey/register/options');
    assert.equal(res.status, 403);
  });

  it('refuses a removed passkey', async () => {
    const browser = new Browser();
    await browser.signInAs(await userId('friend@seerr.dev'));
    const device = new Authenticator();
    const added = await addPasskey(browser, device);
    await browser.call('DELETE', `/passkey/${added.body.id}`);

    assert.equal((await signInWith(device)).status, 403);
  });

  it('refuses a Plex account the server owner stopped sharing with', async () => {
    const browser = new Browser();
    await browser.signInAs(await userId('friend@seerr.dev'));
    const device = new Authenticator();
    await addPasskey(browser, device);

    plexAccess = false;
    const res = await signInWith(device);
    assert.equal(res.status, 403);
    const me = await res.browser.call('GET', '/me');
    assert.equal(me.status, 403, 'not signed in');
  });

  it('refuses Plex accounts when Plex sign-in is turned off', async () => {
    const browser = new Browser();
    await browser.signInAs(await userId('friend@seerr.dev'));
    const device = new Authenticator();
    await addPasskey(browser, device);

    setMediaServerLogin(false);
    assert.equal((await signInWith(device)).status, 403);
  });

  it('lets someone in while any of their connected servers does', async () => {
    const settings = getSettings();
    settings.jellyfin.connected = true;
    settings.jellyfin.ip = 'jellyfin.local';
    settings.jellyfin.apiKey = 'jellyfin-key';
    await getRepository(User).update(
      { email: 'friend@seerr.dev' },
      { jellyfinUserId: 'jf-friend' }
    );
    const browser = new Browser();
    await browser.signInAs(await userId('friend@seerr.dev'));
    const device = new Authenticator();
    await addPasskey(browser, device);

    // No longer shared on Plex, still on Jellyfin.
    plexAccess = false;
    assert.equal((await signInWith(device)).status, 200);

    // Jellyfin's sign-in switched off: a passkey does not stand in for it.
    settings.jellyfin.signIn = false;
    assert.equal((await signInWith(device)).status, 403);

    settings.jellyfin.signIn = true;
    jellyfinEnabled = false;
    assert.equal((await signInWith(device)).status, 403);
  });

  it("follows Plex's own sign-in switch", async () => {
    const browser = new Browser();
    await browser.signInAs(await userId('friend@seerr.dev'));
    const device = new Authenticator();
    await addPasskey(browser, device);

    getSettings().plex.signIn = false;
    assert.equal((await signInWith(device)).status, 403);
    getSettings().plex.signIn = true;
    assert.equal((await signInWith(device)).status, 200);
  });

  it('lets in an account made by single sign-on while password sign-in is off', async () => {
    const users = getRepository(User);
    const sso = await users.save(
      new User({
        email: 'sso@seerr.dev',
        avatar: '',
        permissions: 0,
        userType: UserType.LOCAL,
      })
    );
    await getRepository(OidcLink).save(
      new OidcLink({ user: sso, provider: 'authentik', sub: 'sso-sub' })
    );
    const password = await users.save(
      new User({
        email: 'password@seerr.dev',
        avatar: '',
        permissions: 0,
        userType: UserType.LOCAL,
      })
    );
    const settings = getSettings();
    settings.main.localLogin = false;
    try {
      const ssoDevice = new Authenticator();
      const ssoBrowser = new Browser();
      await ssoBrowser.signInAs(sso.id);
      assert.equal((await addPasskey(ssoBrowser, ssoDevice)).status, 201);
      assert.equal((await signInWith(ssoDevice)).status, 200);

      // A password account's passkey stands in for its password, which is
      // switched off.
      const passwordDevice = new Authenticator();
      const passwordBrowser = new Browser();
      await passwordBrowser.signInAs(password.id);
      assert.equal(
        (await addPasskey(passwordBrowser, passwordDevice)).status,
        201
      );
      assert.equal((await signInWith(passwordDevice)).status, 403);
    } finally {
      settings.main.localLogin = true;
    }
  });

  it('refuses a response made for another site', async () => {
    const browser = new Browser();
    await browser.signInAs(await userId('friend@seerr.dev'));
    const device = new Authenticator();
    await addPasskey(browser, device);

    assert.equal(
      (await signInWith(device, { origin: 'https://evil.test' })).status,
      403
    );
  });

  it('refuses a device claiming to sign in as someone else', async () => {
    const browser = new Browser();
    await browser.signInAs(await userId('friend@seerr.dev'));
    const device = new Authenticator();
    await addPasskey(browser, device);

    const admin = await userId('admin@seerr.dev');
    const res = await signInWith(device, {
      userHandle: b64url(Buffer.from(`seerr-user-${admin}`)),
    });
    assert.equal(res.status, 403);
  });

  it('never accepts the same challenge twice', async () => {
    const browser = new Browser();
    await browser.signInAs(await userId('friend@seerr.dev'));
    const device = new Authenticator();
    await addPasskey(browser, device);

    const signer = new Browser();
    const options = await signer.call('POST', '/passkey/login/options');
    const response = device.get(options.body);
    assert.equal(
      (await signer.call('POST', '/passkey/login', { response })).status,
      200
    );
    assert.equal(
      (await signer.call('POST', '/passkey/login', { response })).status,
      400,
      'replayed'
    );
  });

  it('keeps setup and sign-in challenges apart, and lets them expire', () => {
    const issuedAt = 1_000_000;
    const session = {
      passkeyChallenge: {
        value: 'abc',
        purpose: 'register' as const,
        issuedAt,
      },
    };
    assert.equal(takeChallenge(session, 'login', issuedAt), undefined);
    assert.equal(session.passkeyChallenge, undefined, 'used up either way');

    const fresh = {
      passkeyChallenge: { value: 'abc', purpose: 'login' as const, issuedAt },
    };
    assert.equal(
      takeChallenge(fresh, 'login', issuedAt + 6 * 60 * 1000),
      undefined,
      'expired'
    );
  });
});
