/*
 * Single sign-on through an OpenID Connect provider (Authentik, Authelia,
 * Keycloak, Pocket ID, Google…): the parts the settings page and the server
 * both need to agree on.
 */

/** What a new provider asks for: who someone is, their name and email. */
export const DEFAULT_OIDC_SCOPES = 'openid profile email';

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
  /** Too many failed attempts from here; wait a few minutes. */
  | 'too-many'
  /** Linking: done. */
  | 'linked';

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
