import type { OidcClaimRule, OidcProblem } from '@server/constants/oidc';
import {
  DEFAULT_OIDC_SCOPES,
  normalizeIssuer,
  oidcApplicationUrl,
  oidcCallbackUrl,
  standInEmail,
} from '@server/constants/oidc';
import { UserType } from '@server/constants/user';
import dataSource, { getRepository } from '@server/datasource';
import OidcLink from '@server/entity/OidcLink';
import { User } from '@server/entity/User';
import { withNewUserDefaults } from '@server/lib/newUserDefaults';
import type { OidcProviderSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import gravatarUrl from 'gravatar-url';
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import * as client from 'openid-client';
import type { EntityManager } from 'typeorm';
import { IsNull, Not } from 'typeorm';
import isEmail from 'validator/lib/isEmail';

/*
 * Single sign-on through an OpenID Connect provider (Authentik, Authelia,
 * Keycloak, Pocket ID, Google...).
 *
 * The browser goes to the provider with a fresh state, nonce and PKCE
 * challenge and returns to the callback with a code. The state, PKCE
 * verifier, nonce, provider and return path ride in a short-lived, signed,
 * httpOnly cookie, cleared on use. Users are matched only by provider and
 * the provider's `sub`, never by email.
 */

/** Per-request timeout for provider calls, in seconds. */
export const OIDC_TIMEOUT_SECONDS = 10;

/** How long discovery metadata is cached. */
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

/** Cookie that carries a sign-in to the provider and back. */
export const CORRELATION_COOKIE = 'seerr-sso';

/** Time allowed to finish signing in at the provider. */
export const CORRELATION_TTL_MS = 10 * 60 * 1000;

export const findProvider = (id: string): OidcProviderSettings | undefined =>
  getSettings().oidc.providers.find((provider) => provider.id === id);

/**
 * Whether a provider can be used now: enabled, and the Application URL is set
 * (the callback is built from it).
 */
export const usableProvider = (
  id: string
): OidcProviderSettings | undefined => {
  const provider = findProvider(id);
  return provider?.enabled &&
    oidcApplicationUrl(getSettings().main.applicationUrl)
    ? provider
    : undefined;
};

/**
 * Whether a link can sign in now: its provider is usable and still has the
 * issuer the link was made at. Links from before issuers were recorded have
 * none and follow the provider's.
 */
export const linkUsable = (link: Pick<OidcLink, 'provider' | 'issuer'>) => {
  const provider = usableProvider(link.provider);
  return (
    !!provider &&
    (!link.issuer || link.issuer === normalizeIssuer(provider.issuerUrl))
  );
};

/** The provider's callback URL. */
export const callbackUrlFor = (provider: { id: string }): string =>
  oidcCallbackUrl(
    oidcApplicationUrl(getSettings().main.applicationUrl),
    provider.id
  );

/** Scopes to request: always `openid`, deduplicated. */
export const normalizeScopes = (scopes?: string): string => {
  const asked = (scopes ?? '').split(/\s+/).filter(Boolean);
  if (asked.length === 0) {
    return DEFAULT_OIDC_SCOPES;
  }
  return ['openid', ...new Set(asked.filter((s) => s !== 'openid'))].join(' ');
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * What is wrong with an issuer URL, or undefined if usable. Requires https so
 * codes and the client secret never cross the network unencrypted; plain http
 * is allowed only for this machine.
 */
export const issuerUrlProblem = (
  issuerUrl: string
): OidcProblem | undefined => {
  let url: URL;
  try {
    url = new URL(issuerUrl);
  } catch {
    return { problem: 'issuer-url' };
  }
  if (url.search || url.hash) {
    return { problem: 'issuer-query' };
  }
  if (url.protocol === 'https:') {
    return undefined;
  }
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) {
    return undefined;
  }
  return { problem: 'issuer-https' };
};

type DiscoveryTarget = Pick<
  OidcProviderSettings,
  'issuerUrl' | 'clientId' | 'clientSecret'
>;

const discovered = new Map<
  string,
  { config: client.Configuration; expires: number }
>();

/** Cache key: one entry per issuer, client and secret. */
const discoveryKey = (target: DiscoveryTarget) =>
  [
    target.issuerUrl,
    target.clientId,
    createHash('sha256').update(target.clientSecret).digest('hex'),
  ].join('\n');

/**
 * How the client secret is sent: client_secret_basic (accepted everywhere,
 * Authelia's default) unless the provider only accepts it in the body.
 */
const clientAuthentication =
  (secret: string): client.ClientAuth =>
  (as, metadata, body, headers) => {
    const methods = as.token_endpoint_auth_methods_supported;
    const bodyOnly =
      Array.isArray(methods) &&
      !methods.includes('client_secret_basic') &&
      methods.includes('client_secret_post');
    return (
      bodyOnly
        ? client.ClientSecretPost(secret)
        : client.ClientSecretBasic(secret)
    )(as, metadata, body, headers);
  };

/**
 * Provider metadata (authorization and token endpoints), cached for a few
 * minutes; `fresh` bypasses the cache, as the settings page's Test does.
 */
export const discover = async (
  target: DiscoveryTarget,
  { fresh = false } = {}
): Promise<client.Configuration> => {
  const key = discoveryKey(target);
  const now = Date.now();
  const kept = discovered.get(key);
  if (!fresh && kept && kept.expires > now) {
    return kept.config;
  }

  const issuer = new URL(target.issuerUrl);
  const config = await client.discovery(
    issuer,
    target.clientId,
    undefined,
    clientAuthentication(target.clientSecret),
    {
      timeout: OIDC_TIMEOUT_SECONDS,
      // Only reached for an issuer on this machine (see issuerUrlProblem).
      execute:
        issuer.protocol === 'http:' ? [client.allowInsecureRequests] : [],
    }
  );

  for (const [k, entry] of discovered) {
    if (entry.expires <= now) {
      discovered.delete(k);
    }
  }
  discovered.set(key, { config, expires: now + DISCOVERY_TTL_MS });
  return config;
};

/** Clears the discovery cache, e.g. when settings change. */
export const forgetDiscovery = (): void => discovered.clear();

/** The openid-client or network error code, if any. */
export const errorCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e && 'code' in e
    ? String((e as { code: unknown }).code)
    : undefined;

const causeOf = (e: unknown): unknown =>
  typeof e === 'object' && e && 'cause' in e
    ? (e as { cause: unknown }).cause
    : undefined;

const CERTIFICATE_PROBLEMS = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Scheme, host and port, when the URL has no path. */
const bareOrigin = (issuerUrl: string): string | undefined => {
  try {
    const url = new URL(issuerUrl);
    return url.pathname === '/' ? url.origin : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Why a provider can't be used, for the admin. Contains no secrets: no client
 * secret, token or code.
 */
export const discoveryProblem = (
  e: unknown,
  issuerUrl: string
): OidcProblem => {
  let host = issuerUrl;
  try {
    host = new URL(issuerUrl).host;
  } catch {
    // Not a URL: keep it as typed.
  }
  const code = errorCode(e);
  const cause = causeOf(e);
  const causeCode = errorCode(cause);
  const name = e instanceof Error ? e.name : '';

  if (name === 'TimeoutError' || name === 'AbortError') {
    return {
      problem: 'timeout',
      params: { host, seconds: OIDC_TIMEOUT_SECONDS },
    };
  }
  if (code === 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED') {
    const said = (cause as { body?: { issuer?: unknown } } | undefined)?.body
      ?.issuer;
    return typeof said === 'string'
      ? { problem: 'issuer-mismatch', params: { issuer: said } }
      : { problem: 'issuer-mismatch' };
  }
  if (code === 'OAUTH_RESPONSE_IS_NOT_CONFORM') {
    const status = (cause as { status?: unknown } | undefined)?.status;
    if (typeof status !== 'number') {
      return { problem: 'no-discovery' };
    }
    // Bare host returning 404: Authentik, for one, gives each app its own path
    // under it, which is easy to miss.
    const origin = status === 404 ? bareOrigin(issuerUrl) : undefined;
    return {
      problem: 'no-discovery',
      params: origin ? { status, origin } : { status },
    };
  }
  if (code === 'OAUTH_RESPONSE_IS_NOT_JSON' || code === 'OAUTH_PARSE_ERROR') {
    return { problem: 'not-discovery' };
  }
  if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN') {
    return { problem: 'host-not-found', params: { host } };
  }
  if (causeCode === 'ECONNREFUSED') {
    return { problem: 'refused', params: { host } };
  }
  if (causeCode && CERTIFICATE_PROBLEMS.has(causeCode)) {
    return { problem: 'certificate', params: { host, reason: causeCode } };
  }
  return { problem: 'unreachable', params: { host } };
};

/**
 * English problem text for the log and API clients; the settings page
 * translates its own.
 */
export const problemText = ({ problem, params = {} }: OidcProblem): string => {
  switch (problem) {
    case 'check-details':
      return 'Check the provider details.';
    case 'issuer-url':
      return 'Enter the issuer URL, starting with https://.';
    case 'issuer-query':
      return 'The issuer URL cannot have a ? or # part.';
    case 'issuer-https':
      return 'The issuer URL must start with https://.';
    case 'client-secret':
      return 'Enter the client secret.';
    case 'logo-url':
      return 'The logo must be an address starting with https://, or left blank.';
    case 'claim-name':
      return 'Each rule needs a claim name, without spaces.';
    case 'timeout':
      return `${params.host} did not answer within ${params.seconds} seconds.`;
    case 'issuer-mismatch':
      return params.issuer !== undefined
        ? `The provider gives its issuer URL as ${params.issuer}. Enter exactly that.`
        : 'The provider gives a different issuer URL. Enter it exactly as the provider shows it.';
    case 'no-discovery':
      return `No sign-in details were found at that address${
        params.status !== undefined ? ` (it answered ${params.status})` : ''
      }. Check the issuer URL: Seerr reads /.well-known/openid-configuration under it.${
        params.origin !== undefined
          ? ` Some providers give each app its own address: in Authentik it's ${params.origin}/application/o/<app slug>/, and the provider must be attached to an application.`
          : ''
      }`;
    case 'not-discovery':
      return 'That address answered, but not with sign-in details. Check the issuer URL.';
    case 'host-not-found':
      return `${params.host} could not be found. Check the issuer URL.`;
    case 'refused':
      return `Nothing answered at ${params.host}.`;
    case 'certificate':
      return `${params.host}'s certificate is not trusted (${params.reason}).`;
    case 'unreachable':
      return `Could not reach ${params.host}.`;
  }
};

/*
 * Correlation cookie: signed with the session secret so only this server can
 * have issued it, and carries its own expiry.
 */

export interface Correlation {
  provider: string;
  state: string;
  verifier: string;
  nonce: string;
  /** Return path after sign-in: a path on this site. */
  returnTo: string;
  /** The account being linked; absent when signing in. */
  userId?: number;
  /** Expiry, ms since epoch. */
  expires: number;
}

const signatureOf = (payload: string): Buffer =>
  createHmac('sha256', getSettings().sessionSecret ?? '')
    .update(`oidc-correlation:${payload}`)
    .digest();

export const sealCorrelation = (correlation: Correlation): string => {
  const payload = Buffer.from(JSON.stringify(correlation)).toString(
    'base64url'
  );
  return `${payload}.${signatureOf(payload).toString('base64url')}`;
};

/** The cookie's contents, if genuine and unexpired. */
export const openCorrelation = (
  value: unknown,
  now = Date.now()
): Correlation | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra !== undefined) {
    return undefined;
  }
  const expected = signatureOf(payload);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return undefined;
  }
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString()) as
      | Partial<Correlation>
      | undefined;
    if (
      !c ||
      typeof c.provider !== 'string' ||
      typeof c.state !== 'string' ||
      typeof c.verifier !== 'string' ||
      typeof c.nonce !== 'string' ||
      typeof c.returnTo !== 'string' ||
      typeof c.expires !== 'number' ||
      (c.userId !== undefined && typeof c.userId !== 'number') ||
      c.expires <= now
    ) {
      return undefined;
    }
    return c as Correlation;
  } catch {
    return undefined;
  }
};

/**
 * The provider authorization URL and the cookie that must come back with it.
 */
export const startAtProvider = async (
  provider: OidcProviderSettings,
  { returnTo, userId }: { returnTo: string; userId?: number }
): Promise<{ url: URL; cookie: string }> => {
  const config = await discover(provider);
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrlFor(provider),
    scope: normalizeScopes(provider.scopes),
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });

  return {
    url,
    cookie: sealCorrelation({
      provider: provider.id,
      state,
      verifier,
      nonce,
      returnTo,
      userId,
      expires: Date.now() + CORRELATION_TTL_MS,
    }),
  };
};

/** Who the provider says the user is. */
export interface OidcIdentity {
  /** The provider's id for the user. */
  sub: string;
  /** Email, only when the provider says it is verified. */
  email?: string;
  /** Display name here. */
  displayName?: string;
  /** Label for the account on Linked Accounts. */
  label?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * Finishes a sign-in: exchanges the code for tokens, checking state, PKCE
 * verifier and the ID token's nonce, and reads the identity. Throws on any
 * mismatch.
 */
export const finishAtProvider = async (
  provider: OidcProviderSettings,
  query: string,
  correlation: Correlation
): Promise<{
  identity: OidcIdentity;
  /** ID token claims, overlaid with userinfo when it was read. */
  claims: Record<string, unknown>;
  userinfoFailed?: unknown;
}> => {
  const config = await discover(provider);
  // The callback URL exactly as registered plus the provider's query; never
  // the request's Host header.
  const currentUrl = new URL(callbackUrlFor(provider));
  currentUrl.search = query;

  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: correlation.verifier,
    expectedState: correlation.state,
    expectedNonce: correlation.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims) {
    throw new Error('The provider sent no ID token.');
  }

  // Some providers (Authelia by default) give name, email and groups only via
  // userinfo. Identity comes from the ID token alone; if userinfo fails a
  // linked account still signs in unless the provider has claim rules (the
  // caller decides). Uses the same timeout as other provider requests.
  let details: Record<string, unknown> = { ...claims };
  let userinfoFailed: unknown;
  if (config.serverMetadata().userinfo_endpoint && tokens.access_token) {
    try {
      const userinfo = await client.fetchUserInfo(
        config,
        tokens.access_token,
        claims.sub
      );
      details = { ...claims, ...userinfo, sub: claims.sub };
    } catch (e) {
      userinfoFailed = e;
    }
  }

  const verified =
    details.email_verified === true || details.email_verified === 'true';
  const email = text(details.email)?.toLowerCase();
  const verifiedEmail =
    verified && email && isEmail(email, { require_tld: false })
      ? email
      : undefined;
  const displayName =
    text(details.name) ?? text(details.preferred_username) ?? undefined;

  return {
    identity: {
      sub: claims.sub,
      email: verifiedEmail,
      displayName,
      label: text(details.preferred_username) ?? displayName ?? verifiedEmail,
    },
    claims: details,
    userinfoFailed,
  };
};

/** Whether one claim meets one rule. */
const meets = (claim: unknown, rule: OidcClaimRule): boolean => {
  if (rule.value === undefined) {
    return claim === true || claim === 'true';
  }
  const same = (item: unknown) =>
    (typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean') &&
    String(item) === rule.value;
  return Array.isArray(claim) ? claim.some(same) : same(claim);
};

/**
 * Names of claims failing the provider's sign-in rules (none when there are no
 * rules). All rules must hold. Claim names match exactly, top level only.
 */
export const failedClaims = (
  rules: OidcClaimRule[],
  claims: Record<string, unknown>
): string[] => [
  ...new Set(
    rules
      .filter(
        (rule) =>
          !rule.claim ||
          !Object.hasOwn(claims, rule.claim) ||
          !meets(claims[rule.claim], rule)
      )
      .map((rule) => rule.claim)
  ),
];

/**
 * The link for this provider account at the current issuer, or one from
 * before issuers were recorded. A link from an earlier issuer belongs to
 * someone else: the same `sub` from another provider proves nothing.
 */
const findLink = async (
  provider: OidcProviderSettings,
  sub: string
): Promise<OidcLink | null> => {
  const link = await getRepository(OidcLink).findOne({
    where: { provider: provider.id, sub },
    relations: { user: true },
  });
  return link &&
    (!link.issuer || link.issuer === normalizeIssuer(provider.issuerUrl))
    ? link
    : null;
};

/**
 * Removes earlier-issuer links for this provider that block a new one (same
 * `sub` or same user). They can't sign anyone in while the provider keeps
 * its new issuer, and each provider account and user gets one link per
 * provider.
 */
const dropStaleLinks = async (
  manager: EntityManager,
  provider: OidcProviderSettings,
  { sub, userId }: { sub: string; userId?: number }
) => {
  // Links with no issuer belong to the current issuer, never stale.
  const stale = {
    provider: provider.id,
    issuer: Not(normalizeIssuer(provider.issuerUrl)),
  };
  const found = await manager.find(OidcLink, {
    select: { id: true },
    where: [
      { ...stale, sub },
      ...(userId !== undefined ? [{ ...stale, user: { id: userId } }] : []),
    ],
  });
  if (found.length > 0) {
    await manager.delete(
      OidcLink,
      found.map((link) => link.id)
    );
  }
};

export type SignInResult =
  | { user: User; created: boolean }
  | { refused: 'no-account' | 'existing-account' };

/**
 * The account for a provider sign-in: the one linked to this provider
 * account, or a new one if the provider allows sign-up. Never matched by
 * email: an email match is refused, and its owner links the provider from
 * their profile.
 */
export const accountForSignIn = async (
  provider: OidcProviderSettings,
  identity: OidcIdentity
): Promise<SignInResult> => {
  const links = getRepository(OidcLink);
  const issuer = normalizeIssuer(provider.issuerUrl);
  const link = await findLink(provider, identity.sub);

  if (link) {
    const changes: Partial<OidcLink> = {};
    if (identity.label && identity.label !== link.username) {
      changes.username = identity.label;
    }
    if (!link.issuer) {
      changes.issuer = issuer;
    }
    if (Object.keys(changes).length > 0) {
      await links.update(link.id, changes);
    }
    return { user: link.user, created: false };
  }

  if (!provider.newUserSignUp) {
    return { refused: 'no-account' };
  }

  // Use the email if the provider verified it and no one here has it;
  // otherwise a placeholder no real email can equal, replaceable in profile.
  if (
    identity.email &&
    (await getRepository(User).exists({ where: { email: identity.email } }))
  ) {
    return { refused: 'existing-account' };
  }
  const email = identity.email ?? standInEmail(provider.id, randomUUID());
  const settings = getSettings();

  const user = await dataSource.transaction(async (manager) => {
    await dropStaleLinks(manager, provider, { sub: identity.sub });
    const created = await manager.save(
      withNewUserDefaults(
        new User({
          email,
          username: identity.displayName,
          avatar: gravatarUrl(email, { default: 'mm', size: 200 }),
          permissions: settings.main.defaultPermissions,
          plexToken: '',
          userType: UserType.LOCAL,
        })
      )
    );
    await manager.save(
      new OidcLink({
        user: created,
        provider: provider.id,
        sub: identity.sub,
        issuer,
        username: identity.label ?? null,
      })
    );
    return created;
  });

  return { user, created: true };
};

export type LinkResult =
  | { linked: true }
  | { refused: 'taken' | 'already-linked' };

/**
 * Links a provider account to a local account; refuses one linked to someone
 * else or a second account on the same provider.
 */
export const linkToAccount = async (
  provider: OidcProviderSettings,
  identity: OidcIdentity,
  userId: number
): Promise<LinkResult> => {
  const links = getRepository(OidcLink);
  const issuer = normalizeIssuer(provider.issuerUrl);
  const existing = await findLink(provider, identity.sub);
  if (existing) {
    if (existing.user.id !== userId) {
      return { refused: 'taken' };
    }
    if (!existing.issuer) {
      await links.update(existing.id, { issuer });
    }
    return { linked: true };
  }

  return dataSource.transaction(async (manager): Promise<LinkResult> => {
    await dropStaleLinks(manager, provider, { sub: identity.sub, userId });
    if (
      await manager.exists(OidcLink, {
        where: { provider: provider.id, user: { id: userId } },
      })
    ) {
      return { refused: 'already-linked' };
    }
    await manager.save(
      new OidcLink({
        user: { id: userId } as User,
        provider: provider.id,
        sub: identity.sub,
        issuer,
        username: identity.label ?? null,
      })
    );
    return { linked: true };
  });
};

/**
 * Providers the user can still sign in with: linked, enabled, usable
 * (Application URL set), and at the issuer they linked.
 */
export const usableProviderLinks = async (
  userId: number
): Promise<OidcLink[]> => {
  const links = await getRepository(OidcLink).find({
    where: { user: { id: userId } },
  });
  return links.filter(linkUsable);
};

/**
 * When a provider's issuer URL changes, pins its issuer-less links to the old
 * issuer, so a different provider at the new URL can never use them.
 */
export const keepLinksAtIssuer = async (
  providerId: string,
  oldIssuerUrl: string
): Promise<void> => {
  await getRepository(OidcLink).update(
    { provider: providerId, issuer: IsNull() },
    { issuer: normalizeIssuer(oldIssuerUrl) }
  );
};
