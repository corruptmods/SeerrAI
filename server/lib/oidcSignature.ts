import type { JsonWebKey, KeyObject } from 'node:crypto';
import {
  constants,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify,
} from 'node:crypto';

/*
 * ID token signature check. openid-client checks the claims (issuer,
 * audience, expiry, nonce) but not the signature of a token from the token
 * endpoint. Asymmetric algorithms use the provider's published keys (Google,
 * Keycloak, Pocket ID, Authelia, Authentik with a signing key); HS* uses the
 * client secret, as Authentik does without a signing key.
 */

/** How long a provider's published keys are kept. */
const KEYS_TTL_MS = 10 * 60 * 1000;

/** Least time between two fetches for a key that isn't published. */
const REFETCH_GAP_MS = 30 * 1000;

const HASHES: Record<string, string> = {
  '256': 'sha256',
  '384': 'sha384',
  '512': 'sha512',
};

const EC_CURVES: Record<string, string> = {
  ES256: 'P-256',
  ES384: 'P-384',
  ES512: 'P-521',
};

interface PublishedKey extends JsonWebKey {
  kid?: string;
  use?: string;
  alg?: string;
}

const published = new Map<string, { keys: PublishedKey[]; fetched: number }>();

/** Forgets every provider's published keys. */
export const forgetSigningKeys = (): void => published.clear();

const fetchKeys = async (
  jwksUri: string,
  timeoutSeconds: number
): Promise<PublishedKey[]> => {
  const response = await fetch(jwksUri, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  });
  if (!response.ok) {
    throw new Error(`The provider's keys answered ${response.status}.`);
  }
  const body = (await response.json()) as { keys?: unknown };
  const keys = Array.isArray(body?.keys)
    ? body.keys.filter(
        (key): key is PublishedKey => !!key && typeof key === 'object'
      )
    : [];
  published.set(jwksUri, { keys, fetched: Date.now() });
  return keys;
};

const keysFor = async (
  jwksUri: string,
  timeoutSeconds: number,
  { refresh }: { refresh: boolean }
): Promise<PublishedKey[]> => {
  const kept = published.get(jwksUri);
  const age = kept ? Date.now() - kept.fetched : Infinity;
  if (kept && (refresh ? age < REFETCH_GAP_MS : age < KEYS_TTL_MS)) {
    return kept.keys;
  }
  return fetchKeys(jwksUri, timeoutSeconds);
};

/** The key type an algorithm needs, or undefined if not supported. */
const ktyFor = (alg: string): string | undefined => {
  if (/^(RS|PS)(256|384|512)$/.test(alg)) return 'RSA';
  if (EC_CURVES[alg]) return 'EC';
  if (alg === 'EdDSA' || alg === 'Ed25519') return 'OKP';
  return undefined;
};

const candidates = (
  keys: PublishedKey[],
  alg: string,
  kid: string | undefined
): PublishedKey[] =>
  keys.filter(
    (key) =>
      key.kty === ktyFor(alg) &&
      (!key.use || key.use === 'sig') &&
      (!key.alg || key.alg === alg) &&
      (kid === undefined || key.kid === kid) &&
      (key.kty !== 'EC' || key.crv === EC_CURVES[alg]) &&
      (key.kty !== 'OKP' || key.crv === 'Ed25519')
  );

const verifiesWith = (
  alg: string,
  data: Buffer,
  signature: Buffer,
  jwk: PublishedKey
): boolean => {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return false;
  }
  const hash = HASHES[alg.slice(-3)];
  try {
    if (alg.startsWith('RS')) {
      return verify(hash, data, key, signature);
    }
    if (alg.startsWith('PS')) {
      return verify(
        hash,
        data,
        {
          key,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        },
        signature
      );
    }
    if (alg.startsWith('ES')) {
      return verify(hash, data, { key, dsaEncoding: 'ieee-p1363' }, signature);
    }
    return verify(null, data, key, signature);
  } catch {
    return false;
  }
};

/**
 * Whether an ID token's signature is the provider's: by its published keys
 * (`jwksUri`), or by the client secret for HS256/384/512. Unsigned tokens and
 * unknown algorithms never are.
 */
export const idTokenSignedByProvider = async (
  idToken: string,
  {
    jwksUri,
    clientSecret,
    timeoutSeconds,
  }: { jwksUri?: string; clientSecret: string; timeoutSeconds: number }
): Promise<boolean> => {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    return false;
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header: { alg?: unknown; kid?: unknown };
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString());
  } catch {
    return false;
  }
  const alg = typeof header?.alg === 'string' ? header.alg : '';
  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  const data = Buffer.from(`${encodedHeader}.${encodedPayload}`);
  const signature = Buffer.from(encodedSignature, 'base64url');

  const hmac = /^HS(256|384|512)$/.exec(alg);
  if (hmac) {
    if (!clientSecret) {
      return false;
    }
    const expected = createHmac(HASHES[hmac[1]], clientSecret)
      .update(data)
      .digest();
    return (
      expected.length === signature.length &&
      timingSafeEqual(expected, signature)
    );
  }

  if (!ktyFor(alg) || !jwksUri) {
    return false;
  }
  const check = (keys: PublishedKey[]) =>
    candidates(keys, alg, kid).some((jwk) =>
      verifiesWith(alg, data, signature, jwk)
    );
  if (check(await keysFor(jwksUri, timeoutSeconds, { refresh: false }))) {
    return true;
  }
  // The provider may have rotated its keys since they were fetched.
  return check(await keysFor(jwksUri, timeoutSeconds, { refresh: true }));
};
