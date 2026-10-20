/*
 * Single sign-on through an OpenID Connect provider (Authentik, Authelia,
 * Keycloak, Pocket ID, Google…): the parts the settings page and the server
 * both need to agree on.
 */

/** What a new provider asks for: who someone is, their name and email. */
export const DEFAULT_OIDC_SCOPES = 'openid profile email';

/**
 * The email given to someone who signed up through a provider that gave
 * none (or none it had verified): "<provider id>:<random id>". It is never
 * shown as an email, and they can replace it with a real one.
 */
export const standInEmail = (providerId: string, id: string): string =>
  `${providerId}:${id}`;

const STAND_IN =
  /^[a-z0-9-]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether an email is a stand-in, not one to show or write to. */
export const isStandInEmail = (email: string | null | undefined): boolean =>
  !!email && STAND_IN.test(email);

/**
 * The email to show beside a name, if any: not a stand-in, and not the
 * name again.
 */
export const shownEmail = (
  name: string | null | undefined,
  email: string | null | undefined
): string | undefined =>
  email && !isStandInEmail(email) && name?.toLowerCase() !== email.toLowerCase()
    ? email
    : undefined;

/** The longest id a provider gets from its name. */
const MAX_ID_LENGTH = 40;

/**
 * The id a new provider is given from its name: lower case letters, digits
 * and dashes ("My Authentik!" is "my-authentik"), with a number added when
 * that id is taken. An id is never given twice, not even after its provider
 * was removed: people's links to the old one must never start working for
 * a different provider.
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

/** The address a provider sends people back to after they sign in there. */
export const oidcCallbackUrl = (applicationUrl: string, id: string): string =>
  `${applicationUrl.replace(/\/+$/, '')}/api/v1/auth/oidc/${id}/callback`;

/**
 * Why a sign-in or link through a provider did not go through, as the page
 * it ends on is told (`?sso=`), or that a link did.
 */
export type OidcOutcome =
  /** The provider is switched off, removed, or the Application URL unset. */
  | 'unavailable'
  /** The provider could not be reached, or refused Seerr's request. */
  | 'provider'
  /** The person cancelled, or the provider said no. */
  | 'denied'
  /** Too long, or started in another browser or window. */
  | 'expired'
  /** No account here is linked to theirs, and sign-up is off. */
  | 'no-account'
  /** A new account's email belongs to an account here already. */
  | 'existing-account'
  /** Linking: that account is linked to someone else here. */
  | 'taken'
  /** Linking: they already have an account on this provider linked. */
  | 'already-linked'
  /** The provider's claims for them don't meet its rules. */
  | 'not-allowed'
  /** Too many failed attempts from here; wait a few minutes. */
  | 'too-many'
  /** Linking: done. */
  | 'linked';

/**
 * One rule for who may sign in with a provider. Without a value, the claim
 * must be true (as upstream's `requiredClaims` means). With one, the claim
 * must be exactly that text, or, when it is a list (such as `groups`),
 * contain it.
 */
export interface OidcClaimRule {
  claim: string;
  value?: string;
}

/**
 * Rules as saved, in either form: a list of rules, or upstream's claim
 * names separated by spaces ("is_seerr_user other_claim"), each of which
 * must be true. Names and values are trimmed; a blank value is no value.
 * A rule that can't be read (from a hand-edited settings file) is kept as
 * one with no claim name, which nobody passes: a mistake keeps people out
 * rather than letting everyone in, and the settings page asks for a name.
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
 * The Application URL (Settings → General) providers send people back to,
 * without a trailing slash; blank when it isn't set or isn't a web address.
 * Single sign-on needs it: the address a provider sends people back to has
 * to be registered with the provider in advance.
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

/** Where a provider says what it is, under its issuer: Seerr adds it. */
const DISCOVERY_PATH = /\/\.well-known\/openid-configuration\/*$/i;

/**
 * An issuer URL as an admin entered it, ready to use. Authentik and others
 * show the provider's whole configuration address beside the issuer
 * (…/.well-known/openid-configuration); pasted, it is taken back to the
 * issuer it is under, keeping the slash before it, as Authentik's issuer
 * has one. Anything else is left as it is, without spaces around it.
 */
export const issuerFromEntered = (entered: string): string =>
  entered.trim().replace(DISCOVERY_PATH, '/');

/**
 * An issuer URL as links remember it: without a slash at the end, so the
 * same provider typed with or without one, or as its configuration
 * address, is the same provider.
 */
export const normalizeIssuer = (issuerUrl: string): string =>
  issuerFromEntered(issuerUrl).replace(/\/+$/, '');

/**
 * What is wrong with a provider in Settings → Users → Single Sign-On, as a
 * code the settings page puts in the admin's language, with the details it
 * needs. The server's log keeps the English.
 */
export type OidcProblemCode =
  /** The request could not be read. */
  | 'check-details'
  /** The issuer URL is not an address. */
  | 'issuer-url'
  /** The issuer URL has a ? or # part. */
  | 'issuer-query'
  /** The issuer URL is not https (or http on this machine). */
  | 'issuer-https'
  /** No client secret, entered or saved for this issuer. */
  | 'client-secret'
  /** The logo is not https or a picture on this site. */
  | 'logo-url'
  /** A rule for who may sign in has no claim name, or one with spaces. */
  | 'claim-name'
  /** `host` did not answer within `seconds`. */
  | 'timeout'
  /** The provider calls itself by another issuer URL (`issuer`, if said). */
  | 'issuer-mismatch'
  /**
   * Nothing at the discovery address (`status`, if it answered). With only
   * a host entered and a 404, `origin` too: some providers (Authentik) give
   * each app its own address under it.
   */
  | 'no-discovery'
  /** Something answered, but not with a discovery document. */
  | 'not-discovery'
  /** `host` could not be found. */
  | 'host-not-found'
  /** Nothing answered at `host`. */
  | 'refused'
  /** `host`'s certificate is not trusted (`reason`). */
  | 'certificate'
  /** `host` could not be reached. */
  | 'unreachable';

export interface OidcProblem {
  problem: OidcProblemCode;
  params?: Record<string, string | number>;
}
