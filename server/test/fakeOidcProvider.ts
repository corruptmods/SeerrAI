import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import http from 'node:http';

/*
 * An OpenID Connect provider on localhost for tests, standing in for
 * Authentik, Keycloak and the like: discovery, an authorization endpoint
 * that signs in whoever a test chooses, a token endpoint that checks the
 * client's secret and the PKCE verifier, ID tokens signed with a test key
 * (published as JWKS), and userinfo. Seerr talks to it over real HTTP with
 * the real openid-client.
 */

export interface FakeOidcAccount {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
}

export interface FakeOidcProvider {
  /** http://127.0.0.1:<port>/realms/test, once started. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** How many times the discovery document was fetched. */
  discoveryCalls: number;
  /** Every token request, as received. */
  tokenRequests: URLSearchParams[];
  /** Answers discovery with a server error while set. */
  down: boolean;
  /** Puts these claims only in userinfo, not in the ID token. */
  claimsInUserinfoOnly: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => void;
  /**
   * The browser arriving at the authorization URL Seerr sent it to, signed
   * in there as `account`: where the provider sends it back to (the
   * callback, with a code and the state). `nonce` replaces the nonce the
   * ID token will carry; `state` replaces the state sent back.
   */
  authorize: (
    authorizationUrl: string,
    account: FakeOidcAccount,
    tamper?: { nonce?: string; state?: string }
  ) => Promise<URL>;
}

interface IssuedCode {
  account: FakeOidcAccount;
  nonce?: string;
  challenge: string;
  redirectUri: string;
}

const base64url = (data: Buffer | string) =>
  Buffer.from(data).toString('base64url');

const signJwt = (
  key: KeyObject,
  kid: string,
  claims: Record<string, unknown>
): string => {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const payload = base64url(JSON.stringify(claims));
  const signature = sign(
    'sha256',
    Buffer.from(`${header}.${payload}`),
    key
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
};

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });

export const createFakeOidcProvider = (): FakeOidcProvider => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const kid = 'test-key';
  const codes = new Map<string, IssuedCode>();
  const accessTokens = new Map<string, FakeOidcAccount>();
  let port = 0;

  const fake: FakeOidcProvider = {
    issuer: '',
    clientId: 'seerr-client',
    clientSecret: 'seerr-client-secret',
    discoveryCalls: 0,
    tokenRequests: [],
    down: false,
    claimsInUserinfoOnly: false,
    start: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          port = (server.address() as { port: number }).port;
          fake.issuer = `http://127.0.0.1:${port}/realms/test`;
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    reset: () => {
      codes.clear();
      accessTokens.clear();
      fake.discoveryCalls = 0;
      fake.tokenRequests = [];
      fake.down = false;
      fake.claimsInUserinfoOnly = false;
    },
    authorize: async (authorizationUrl, account, tamper = {}) => {
      const url = new URL(authorizationUrl);
      const params = url.searchParams;
      if (
        url.origin + url.pathname !== `${fake.issuer}/authorize` ||
        params.get('client_id') !== fake.clientId ||
        params.get('response_type') !== 'code' ||
        params.get('code_challenge_method') !== 'S256' ||
        !params.get('code_challenge') ||
        !params.get('redirect_uri')
      ) {
        throw new Error(`Not an authorization request: ${authorizationUrl}`);
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, {
        account,
        nonce: tamper.nonce ?? params.get('nonce') ?? undefined,
        challenge: params.get('code_challenge') as string,
        redirectUri: params.get('redirect_uri') as string,
      });
      const back = new URL(params.get('redirect_uri') as string);
      back.searchParams.set('code', code);
      back.searchParams.set('state', tamper.state ?? params.get('state') ?? '');
      // Keycloak sends this as well; Seerr has no use for it.
      back.searchParams.set('session_state', 'abc');
      return back;
    },
  };

  const claimsOf = (account: FakeOidcAccount) => {
    const { sub, ...rest } = account;
    return { sub, ...rest };
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const path = url.pathname.replace(/^\/realms\/test/, '');

    if (path === '/.well-known/openid-configuration') {
      fake.discoveryCalls += 1;
      if (fake.down) {
        return json(res, 500, { error: 'down' });
      }
      return json(res, 200, {
        issuer: fake.issuer,
        authorization_endpoint: `${fake.issuer}/authorize`,
        token_endpoint: `${fake.issuer}/token`,
        userinfo_endpoint: `${fake.issuer}/userinfo`,
        jwks_uri: `${fake.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: [
          'client_secret_basic',
          'client_secret_post',
        ],
        scopes_supported: ['openid', 'profile', 'email'],
      });
    }

    if (path === '/jwks') {
      return json(res, 200, {
        keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256' }],
      });
    }

    if (path === '/token' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req));
      fake.tokenRequests.push(body);
      const basic = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64')
            .toString()
            .split(':')
            .map(decodeURIComponent)
        : undefined;
      const [clientId, secret] = basic ?? [
        body.get('client_id'),
        body.get('client_secret'),
      ];
      if (clientId !== fake.clientId || secret !== fake.clientSecret) {
        return json(res, 401, { error: 'invalid_client' });
      }
      const issued = codes.get(body.get('code') ?? '');
      codes.delete(body.get('code') ?? '');
      const verifier = body.get('code_verifier') ?? '';
      if (
        !issued ||
        body.get('grant_type') !== 'authorization_code' ||
        body.get('redirect_uri') !== issued.redirectUri ||
        createHash('sha256').update(verifier).digest('base64url') !==
          issued.challenge
      ) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      const now = Math.floor(Date.now() / 1000);
      const accessToken = randomBytes(16).toString('hex');
      accessTokens.set(accessToken, issued.account);
      const idToken = signJwt(privateKey, kid, {
        iss: fake.issuer,
        aud: fake.clientId,
        iat: now,
        exp: now + 300,
        ...(issued.nonce ? { nonce: issued.nonce } : {}),
        ...(fake.claimsInUserinfoOnly
          ? { sub: issued.account.sub }
          : claimsOf(issued.account)),
      });
      return json(res, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
      });
    }

    if (path === '/userinfo') {
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const account = accessTokens.get(token);
      if (!account) {
        return json(res, 401, { error: 'invalid_token' });
      }
      return json(res, 200, claimsOf(account));
    }

    json(res, 404, { error: 'not_found' });
  });

  return fake;
};
