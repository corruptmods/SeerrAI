/*
 * Same-tab Plex sign-in, for when the popup can't open (blocker, installed
 * app, no popups).
 *
 * The page goes to Plex with a `forwardUrl` back to itself carrying
 * `?plexPin=<id>`. The PIN (id and code) stays in this tab's sessionStorage,
 * so only the starting tab can finish; a URL with someone else's PIN id is
 * never used. On return the page checks the PIN with Plex and continues as
 * from the popup. The token never appears in a URL.
 */

/** Where a Plex sign-in started, so the same place finishes it. */
export type PlexSignInPurpose = 'login' | 'setup' | 'link' | 'connect';

export interface PendingPlexSignIn {
  id: number;
  code: string;
  purpose: PlexSignInPurpose;
  /** Start time, epoch ms. */
  startedAt: number;
}

/** Query parameter carrying the PIN id back from Plex. */
export const PLEX_RETURN_PARAM = 'plexPin';

const STORAGE_KEY = 'seerr-plex-sign-in';

/** How long a pending sign-in can finish. Slightly longer than Plex's PIN lifetime, so Plex expires first. */
export const PENDING_LIFETIME_MS = 30 * 60 * 1000;

const PURPOSES: PlexSignInPurpose[] = ['login', 'setup', 'link', 'connect'];

type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** This tab's sessionStorage, or undefined if unavailable. */
export const sessionStore = (): SessionStore | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    // Storage disabled for the site.
    return undefined;
  }
};

/**
 * Stores the PIN for the return. False if storage is off or full, in which
 * case the tab must not be sent to Plex.
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
    // Unreadable: nothing pending.
  }
  return undefined;
};

export const clearPendingPlexSignIn = (store: SessionStore | undefined) => {
  try {
    store?.removeItem(STORAGE_KEY);
  } catch {
    // It expires on its own.
  }
};

/**
 * The return URL for Plex: this page with the PIN id set (replacing any
 * earlier one), other parameters kept.
 */
export const plexForwardUrl = (href: string, pinId: number): string => {
  const url = new URL(href);
  url.hash = '';
  url.searchParams.set(PLEX_RETURN_PARAM, String(pinId));
  return url.toString();
};

/** The URL without the PIN id. */
export const withoutPlexReturn = (href: string): string => {
  const url = new URL(href);
  url.searchParams.delete(PLEX_RETURN_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
};

export type PlexReturn =
  /** Nothing to do here. */
  | { kind: 'none' }
  /** Back with this tab's PIN: check with Plex whether it was claimed. */
  | { kind: 'check'; pending: PendingPlexSignIn }
  /** Back without the PIN id: left Plex without signing in. */
  | { kind: 'notSignedIn' }
  /** PIN too old, or not started by this tab. */
  | { kind: 'expired' };

/**
 * What a page does on load, from its `plexPin`, this tab's pending sign-in
 * and its purpose. A sign-in pending for another page is left alone.
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
 * Whether a Plex return awaits this purpose, for pages that must first open
 * their sign-in UI (setup's sign-in step, the Connect Plex dialog).
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
