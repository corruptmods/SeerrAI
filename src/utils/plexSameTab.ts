/*
 * Signing in with Plex in the same tab, for when the Plex window can't be
 * opened (a pop-up blocker, an installed app, a browser without pop-ups).
 *
 * The page goes to Plex's sign-in with a `forwardUrl` back to itself,
 * carrying the PIN's id as `?plexPin=`. The PIN itself (its id and code)
 * waits in this tab's sessionStorage, so only the tab that started a sign-in
 * can finish it: an address with someone else's PIN id in it is never used.
 * Coming back, the page asks Plex once whether the PIN was claimed, and goes
 * on exactly as it would have from the window. The token never appears in
 * an address.
 */

/** Where a Plex sign-in was started, so the same place finishes it. */
export type PlexSignInPurpose = 'login' | 'setup' | 'link' | 'connect';

export interface PendingPlexSignIn {
  id: number;
  code: string;
  purpose: PlexSignInPurpose;
  /** When it was started, in milliseconds. */
  startedAt: number;
}

/** The address parameter Plex sends people back with. */
export const PLEX_RETURN_PARAM = 'plexPin';

const STORAGE_KEY = 'seerr-plex-sign-in';

/**
 * How long a sign-in started in this tab can still be finished. Plex's own
 * PINs last a little less than this, so Plex is what says no first.
 */
export const PENDING_LIFETIME_MS = 30 * 60 * 1000;

const PURPOSES: PlexSignInPurpose[] = ['login', 'setup', 'link', 'connect'];

type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** This tab's sessionStorage, or undefined where it can't be used. */
export const sessionStore = (): SessionStore | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    // Storage switched off for the site.
    return undefined;
  }
};

/**
 * Keeps the PIN for the return. False when it could not be kept (storage
 * switched off or full): the sign-in can't come back here then, so it must
 * not be sent away.
 */
export const savePendingPlexSignIn = (
  store: SessionStore | undefined,
  pending: PendingPlexSignIn
): boolean => {
  if (!store) return false;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(pending));
    return store.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
};

export const readPendingPlexSignIn = (
  store: SessionStore | undefined
): PendingPlexSignIn | undefined => {
  try {
    const raw = store?.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<PendingPlexSignIn>;
    if (
      typeof value.id === 'number' &&
      Number.isInteger(value.id) &&
      typeof value.code === 'string' &&
      !!value.code &&
      typeof value.startedAt === 'number' &&
      PURPOSES.includes(value.purpose as PlexSignInPurpose)
    ) {
      return value as PendingPlexSignIn;
    }
  } catch {
    // Unreadable: treated as nothing pending.
  }
  return undefined;
};

export const clearPendingPlexSignIn = (store: SessionStore | undefined) => {
  try {
    store?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing more can be done; it expires on its own.
  }
};

/**
 * The address Plex sends someone back to: the page they are on, with the
 * PIN's id added (and any earlier one replaced). Everything else in the
 * address, such as where to go after signing in, is kept.
 */
export const plexForwardUrl = (href: string, pinId: number): string => {
  const url = new URL(href);
  url.hash = '';
  url.searchParams.set(PLEX_RETURN_PARAM, String(pinId));
  return url.toString();
};

/** The same address without the PIN's id, for once it has been dealt with. */
export const withoutPlexReturn = (href: string): string => {
  const url = new URL(href);
  url.searchParams.delete(PLEX_RETURN_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
};

export type PlexReturn =
  /** Nothing to do here. */
  | { kind: 'none' }
  /** Back from Plex with this tab's PIN: ask Plex whether it was claimed. */
  | { kind: 'check'; pending: PendingPlexSignIn }
  /** Back without the PIN's id: they left Plex without signing in. */
  | { kind: 'notSignedIn' }
  /** A PIN that is too old, or not one this tab started. */
  | { kind: 'expired' };

/**
 * What a page should do on loading, from the `plexPin` in its address (if
 * any), the sign-in this tab has waiting (if any), and what the page signs
 * in for. A sign-in waiting for another page is left for that page.
 */
export const plexReturnOf = (
  param: string | null | undefined,
  pending: PendingPlexSignIn | undefined,
  purpose: PlexSignInPurpose,
  now: number
): PlexReturn => {
  if (pending && pending.purpose !== purpose) {
    return { kind: 'none' };
  }
  if (!pending) {
    return param ? { kind: 'expired' } : { kind: 'none' };
  }
  const age = now - pending.startedAt;
  if (age < 0 || age > PENDING_LIFETIME_MS) {
    return param ? { kind: 'expired' } : { kind: 'none' };
  }
  if (!param) {
    return { kind: 'notSignedIn' };
  }
  return param === String(pending.id)
    ? { kind: 'check', pending }
    : { kind: 'expired' };
};

/**
 * Whether this page has a Plex sign-in to finish (or to say did not
 * happen), for pages that must first open the part of themselves that
 * signs in: setup's sign-in step, the Connect Plex dialog.
 */
export const hasPlexReturn = (purpose: PlexSignInPurpose): boolean => {
  if (typeof window === 'undefined') return false;
  const param = new URLSearchParams(window.location.search).get(
    PLEX_RETURN_PARAM
  );
  return (
    plexReturnOf(
      param,
      readPendingPlexSignIn(sessionStore()),
      purpose,
      Date.now()
    ).kind !== 'none'
  );
};
