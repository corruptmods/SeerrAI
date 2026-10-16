import type { OidcClaimRule, OidcProblem } from '@server/constants/oidc';
import {
  DEFAULT_OIDC_SCOPES,
  normalizeIssuer,
  oidcApplicationUrl,
  oidcCallbackUrl,
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
 * Single sign-on: signing in through an OpenID Connect provider such as
 * Authentik, Authelia, Keycloak, Pocket ID or Google.
 *
 * The browser is sent to the provider with a fresh state, nonce and PKCE
 * challenge, and comes back to the provider's callback address with a code.
 * What ties the two together (the state, the PKCE verifier, the nonce,
 * which provider and where to go afterwards) rides in a short-lived, signed,
 * httpOnly cookie, cleared when it is used. People are found only by the
 * provider and the provider's own id for them (`sub`), never by email.
 */

/** How long a provider has to answer each request, in seconds. */
export const OIDC_TIMEOUT_SECONDS = 10;

/** How long what a provider says about itself is reused. */
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

/** The cookie that carries a sign-in from here to the provider and back. */
export const CORRELATION_COOKIE = 'seerr-sso';

/** How long someone has to finish signing in at the provider. */
export const CORRELATION_TTL_MS = 10 * 60 * 1000;

export const findProvider = (id: string): OidcProviderSettings | undefined =>
  getSettings().oidc.providers.find((provider) => provider.id === id);

/**
 * A provider people can sign in with or link right now: it is switched on,
 * and the Application URL is set (the provider sends people back there).
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
 * Whether a link can sign someone in now: its provider can be used, and
 * still has the issuer the link was made at. A link from before issuers
 * were recorded has none, and goes with the provider's.
 */
export const linkUsable = (link: Pick<OidcLink, 'provider' | 'issuer'>) => {
  const provider = usableProvider(link.provider);
  return (
    !!provider &&
    (!link.issuer || link.issuer === normalizeIssuer(provider.issuerUrl))
  );
};

/** Where this provider sends people back to. */
export const callbackUrlFor = (provider: { id: string }): string =>
  oidcCallbackUrl(
    oidcApplicationUrl(getSettings().main.applicationUrl),
    provider.id
  );

/** The scopes asked for: always `openid`, each once. */
export const normalizeScopes = (scopes?: string): string => {
  const asked = (scopes ?? '').split(/\s+/).filter(Boolean);
  if (asked.length === 0) {
    return DEFAULT_OIDC_SCOPES;
  }
  return ['openid', ...new Set(asked.filter((s) => s !== 'openid'))].join(' ');
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * What is wrong with an issuer URL, or undefined when it can be used. A
 * provider is reached over https: a sign-in's code and the client secret
 * must not cross a network unencrypted. Plain http is only accepted on this
 * machine itself.
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

/** One entry per provider address, client and secret. */
const discoveryKey = (target: DiscoveryTarget) =>
  [
    target.issuerUrl,
    target.clientId,
    createHash('sha256').update(target.clientSecret).digest('hex'),
  ].join('\n');

/**
 * How Seerr shows the provider its client secret: in an Authorization
 * header (client_secret_basic), which every provider takes and Authelia
 * expects by default, unless the provider says it only takes it in the
 * request body.
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
 * What the provider says about itself: where to send people, where to
 * trade a code for tokens. Kept for a few minutes; `fresh` asks again, as
 * the settings page's Test does.
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

/** Forgets what providers said about themselves, as when settings change. */
export const forgetDiscovery = (): void => discovered.clear();

/** The error code openid-client (or the network) gives, when there is one. */
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

/**
 * Why a provider could not be used, for the admin setting it up. Nothing
 * secret is in it: no client secret, token or code.
 */
export const discoveryProblem = (
  e: unknown,
  issuerUrl: string
): OidcProblem => {
  let host = issuerUrl;
  try {
    host = new URL(issuerUrl).host;
  } catch {
    // The address as typed.
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
    return typeof status === 'number'
      ? { problem: 'no-discovery', params: { status } }
      : { problem: 'no-discovery' };
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
 * A problem in plain English, for the log and for anyone reading the API
 * without the settings page. The settings page shows its own translation.
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
        ? `The provider gives its issuer URL as ${params.issuer}. Enter exactly that (a slash at the end counts).`
        : 'The provider gives a different issuer URL. Enter it exactly as the provider shows it.';
    case 'no-discovery':
      return `No sign-in details were found at that address${
        params.status !== undefined ? ` (it answered ${params.status})` : ''
      }. Check the issuer URL: Seerr reads /.well-known/openid-configuration under it.`;
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
 * The correlation cookie. Signed with the session secret, so it can only
 * have come from here; it also says when it stops being good.
 */

export interface Correlation {
  /** The provider. */
  provider: string;
  state: string;
  verifier: string;
  nonce: string;
  /** Where to go afterwards: a path on this site. */
  returnTo: string;
  /** Linking: the account it is for. Absent when signing in. */
  userId?: number;
  /** When it stops being good (ms since 1970). */
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

/** What the cookie says, if it is genuine and still good. */
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
 * Where to send the browser to sign in at the provider, and the cookie
 * that has to come back with it.
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

/** Who the provider says someone is. */
export interface OidcIdentity {
  /** The provider's own id for them. */
  sub: string;
  /** Their email, only when the provider says it has been verified. */
  email?: string;
  /** What to call them here. */
  displayName?: string;
  /** What to show for the account on Linked Accounts. */
  label?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * Finishes a sign-in: trades the code the provider sent back for tokens,
 * checking the state, the PKCE verifier and the ID token's nonce on the
 * way, and reads who it is. Throws when anything does not match.
 */
export const finishAtProvider = async (
  provider: OidcProviderSettings,
  query: string,
  correlation: Correlation
): Promise<{
  identity: OidcIdentity;
  /** The ID token's claims, with userinfo's over them when it was read. */
  claims: Record<string, unknown>;
  userinfoFailed?: unknown;
}> => {
  const config = await discover(provider);
  // The callback address exactly as registered, with what the provider
  // added to it; nothing from the request's own Host header.
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

  // Some providers (Authelia, by default) give the name, email and groups
  // only from userinfo. Who someone is comes from the ID token alone;
  // without userinfo a linked account still signs in, unless the
  // provider has rules for who may (the caller decides). It is asked with
  // the same timeout as every other request to the provider.
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
 * The names of the claims that don't meet a provider's rules for who may
 * sign in (none when everyone may). Every rule has to hold. Claim names are
 * matched exactly, at the top level only.
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
 * The link for this provider account at the provider's current issuer:
 * one made there, or one from before issuers were recorded. A link made
 * at an earlier issuer is someone else's: the same `sub` from a different
 * provider says nothing about who they are.
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
 * Removes links to a provider made at an earlier issuer that are in the
 * way of a new one: with the same `sub`, or the same person's. They can
 * never sign anyone in while the provider keeps its new issuer, and each
 * provider account, and each person, has one link per provider.
 */
const dropStaleLinks = async (
  manager: EntityManager,
  provider: OidcProviderSettings,
  { sub, userId }: { sub: string; userId?: number }
) => {
  // Links with no issuer yet are the current issuer's, never stale.
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
 * The account a provider sign-in belongs to: the one linked to this
 * provider account, or, when the provider lets new people sign up, a new
 * one. Never one found by email: an email match is refused instead, and
 * its owner links the provider from their profile.
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

  // Their email, when the provider has verified it and nobody here has
  // it; otherwise a stand-in no email can be, which they can replace in
  // their profile.
  if (
    identity.email &&
    (await getRepository(User).exists({ where: { email: identity.email } }))
  ) {
    return { refused: 'existing-account' };
  }
  const email = identity.email ?? `${provider.id}:${randomUUID()}`;
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
 * Links a provider account to someone's account here: not one already
 * linked to someone else, and not a second account on the same provider.
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
 * The providers someone could still sign in with: those they have linked
 * that are switched on (and usable, with the Application URL set), at the
 * issuer they linked.
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
 * When a provider's issuer URL changes, its links that have no issuer yet
 * are tied to the old one, so a different provider at the new address can
 * never sign anyone in through them.
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
