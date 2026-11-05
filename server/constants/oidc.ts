// Single sign-on via OpenID Connect (Authentik, Authelia, Keycloak, Pocket ID,
// Google…): shared by the settings page and the server.

/** Scopes requested by default: identity, name and email. */
export const DEFAULT_OIDC_SCOPES = 'openid profile email';

/**
 * Stand-in email for a sign-up whose provider gave no (verified) email:
 * "<provider id>:<random id>". Never shown as an email; the user can replace
 * it.
 */
export const standInEmail = (providerId: string, id: string): string =>
  `${providerId}:${id}`;

const STAND_IN =
  /^[a-z0-9-]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether an email is a stand-in, not one to show or send to. */
export const isStandInEmail = (email: string | null | undefined): boolean =>
  !!email && STAND_IN.test(email);

/**
 * The email to show beside a name, unless it's a stand-in or the name itself.
 */
export const shownEmail = (
  name: string | null | undefined,
  email: string | null | undefined
): string | undefined =>
  email && !isStandInEmail(email) && name?.toLowerCase() !== email.toLowerCase()
    ? email
    : undefined;

const MAX_ID_LENGTH = 40;

/**
 * A new provider's id from its name: lowercase letters, digits and dashes ("My
 * Authentik!" is "my-authentik"), numbered if taken. Ids are never reused, even
 * after removal, so old links can't start working for a different provider.
 */
export const oidcProviderId = (name: string, taken: string[]): string => {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_ID_LENGTH)
      .replace(/-+$/, '') || 'sso';
  const used = new Set(taken);
  let id = base;
  for (let n = 2; used.has(id); n++) {
    id = `${base}-${n}`;
  }
  return id;
};

/** The provider's redirect URI after sign-in. */
export const oidcCallbackUrl = (applicationUrl: string, id: string): string =>
  `${applicationUrl.replace(/\/+$/, '')}/api/v1/auth/oidc/${id}/callback`;

/**
 * A provider sign-in or link outcome, passed to the landing page as `?sso=`.
 */
export type OidcOutcome =
  /** Provider disabled or removed, or Application URL unset. */
  | 'unavailable'
  /** Provider unreachable, or it refused Seerr's request. */
  | 'provider'
  /** The user cancelled, or the provider denied. */
  | 'denied'
  /** Took too long, or started in another browser or window. */
  | 'expired'
  /** No linked account here, and sign-up is off. */
  | 'no-account'
  /** A new account's email already belongs to an account here. */
  | 'existing-account'
  /** Linking: that provider account is linked to someone else. */
  | 'taken'
  /** Linking: they already have an account on this provider linked. */
  | 'already-linked'
  /** Their claims don't meet the provider's rules. */
  | 'not-allowed'
  /** Too many failed attempts; wait a few minutes. */
  | 'too-many'
  /** Linking succeeded. */
  | 'linked';

/**
 * One sign-in rule. Without a value, the claim must be true (like upstream's
 * `requiredClaims`). With one, the claim must equal it or, for a list claim
 * such as `groups`, contain it.
 */
export interface OidcClaimRule {
  claim: string;
  value?: string;
}

/**
 * Parses saved rules in either form: a rule list, or upstream's space-separated
 * claim names ("is_seerr_user other_claim") that must each be true. Names and
 * values are trimmed; a blank value means none. An unreadable rule (hand-edited
 * settings) becomes one with no claim name, which nobody passes, so a mistake
 * locks people out rather than letting everyone in.
 */
export const requiredClaimsFrom = (saved: unknown): OidcClaimRule[] => {
  if (saved === undefined || saved === null) {
    return [];
  }
  if (typeof saved === 'string') {
    return saved
      .split(/\s+/)
      .filter(Boolean)
      .map((claim) => ({ claim }));
  }
  if (!Array.isArray(saved)) {
    return [{ claim: '' }];
  }
  return saved.map((rule): OidcClaimRule => {
    const { claim, value }: { claim?: unknown; value?: unknown } =
      rule && typeof rule === 'object' ? rule : {};
    const name = typeof claim === 'string' ? claim.trim() : '';
    const wanted =
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
        ? String(value).trim()
        : '';
    return wanted ? { claim: name, value: wanted } : { claim: name };
  });
};

/**
 * The Application URL (Settings → General) without a trailing slash, or blank
 * when unset or not a web address. SSO requires it, since the redirect URI must
 * be registered with the provider.
 */
export const oidcApplicationUrl = (applicationUrl?: string): string => {
  const value = (applicationUrl ?? '').trim();
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? value.replace(/\/+$/, '')
      : '';
  } catch {
    return '';
  }
};

/** The discovery document path under an issuer; Seerr appends it. */
const DISCOVERY_PATH = /\/\.well-known\/openid-configuration\/*$/i;

/**
 * Normalizes an entered issuer URL. A pasted discovery address
 * (…/.well-known/openid-configuration) is cut back to its issuer, keeping the
 * trailing slash since Authentik's issuer has one. Otherwise only trimmed.
 */
export const issuerFromEntered = (entered: string): string =>
  entered.trim().replace(DISCOVERY_PATH, '/');

/**
 * An issuer URL as links store it: no trailing slash, so the same provider
 * entered with or without one, or as its discovery address, matches.
 */
export const normalizeIssuer = (issuerUrl: string): string =>
  issuerFromEntered(issuerUrl).replace(/\/+$/, '');

/**
 * A provider problem in Settings → Users → Single Sign-On, as a code the
 * settings page localizes using the details it needs. The server log keeps the
 * English.
 */
export type OidcProblemCode =
  /** The request couldn't be parsed. */
  | 'check-details'
  /** The issuer URL isn't a URL. */
  | 'issuer-url'
  /** The issuer URL has a ? or # part. */
  | 'issuer-query'
  /** The issuer URL isn't https (or http on localhost). */
  | 'issuer-https'
  /** No client secret entered or saved for this issuer. */
  | 'client-secret'
  /** The logo isn't https or an image on this site. */
  | 'logo-url'
  /** A sign-in rule has no claim name, or one with spaces. */
  | 'claim-name'
  /** `host` didn't answer within `seconds`. */
  | 'timeout'
  /** The provider reports a different issuer URL (`issuer`, if given). */
  | 'issuer-mismatch'
  /**
   * Nothing at the discovery address (`status`, if it answered). With only a
   * host entered and a 404, also `origin`: some providers (Authentik) give each
   * app its own path under it.
   */
  | 'no-discovery'
  /** Something answered, but not with a discovery document. */
  | 'not-discovery'
  /** `host` couldn't be resolved. */
  | 'host-not-found'
  /** Connection refused at `host`. */
  | 'refused'
  /** `host`'s certificate isn't trusted (`reason`). */
  | 'certificate'
  /** `host` couldn't be reached. */
  | 'unreachable';

export interface OidcProblem {
  problem: OidcProblemCode;
  params?: Record<string, string | number>;
}
