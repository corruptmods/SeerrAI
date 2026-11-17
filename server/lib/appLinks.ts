import { randomBytes, randomInt } from 'crypto';

/*
 * Linking a browser app (routes/appLink), as a TV signs in with a code: the
 * app asks for a link and shows its code; its user enters the code in Seerr
 * AI while signed in and allows it; the app, waiting on the link's id, is
 * handed a key once.
 *
 * Links live in memory for ten minutes: a restart only means starting again.
 * The code is what a person types; the id, which only the app knows, is what
 * collects the key, so seeing someone's code never gets you their key.
 */

const LINK_LIFETIME_MS = 10 * 60 * 1000;
/** After it's approved, how long a key waits to be collected. */
const COLLECT_WITHIN_MS = 2 * 60 * 1000;
/** The most links waiting at once, across everyone. */
export const MOST_WAITING_LINKS = 100;

/** No 0/O, 1/I/L or U, so a code reads and types unambiguously. */
const CODE_LETTERS = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export type AppLinkState = 'waiting' | 'approved' | 'declined';

export interface AppLink {
  id: string;
  /** Six letters, shown as K7M-Q2X. */
  code: string;
  /** What the app calls itself, as it says. */
  app: string;
  /** The site it asked from: what the person is really allowing. */
  origin: string;
  expiresAt: number;
  state: AppLinkState;
  /** Once approved: the key, until the app collects it. */
  secret?: string;
  keyId?: number;
  userId?: number;
}

const links = new Map<string, AppLink>();

/** For tests: forgets every link. */
export const resetAppLinksForTests = (): void => links.clear();

const newCode = (): string =>
  Array.from(
    { length: 6 },
    () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]
  ).join('');

/** A code as typed, with or without its dash or spaces, any case. */
export const normaliseCode = (typed: string): string =>
  typed.toUpperCase().replace(/[\s-]/g, '');

export const displayCode = (code: string): string =>
  `${code.slice(0, 3)}-${code.slice(3)}`;

/**
 * Ends links past their time. Returns the keys made for links nobody
 * collected, for the caller to delete.
 */
export const sweepAppLinks = (now = Date.now()): number[] => {
  const uncollected: number[] = [];
  for (const [id, link] of links) {
    if (link.expiresAt <= now) {
      links.delete(id);
      if (link.state === 'approved' && link.keyId !== undefined) {
        uncollected.push(link.keyId);
      }
    }
  }
  return uncollected;
};

/** A new link, or undefined while too many are waiting. */
export const startAppLink = (
  app: string,
  origin: string,
  now = Date.now()
): AppLink | undefined => {
  if (links.size >= MOST_WAITING_LINKS) {
    return undefined;
  }
  const waiting = new Set([...links.values()].map((link) => link.code));
  let code = newCode();
  while (waiting.has(code)) {
    code = newCode();
  }
  const link: AppLink = {
    id: randomBytes(24).toString('base64url'),
    code,
    app,
    origin,
    expiresAt: now + LINK_LIFETIME_MS,
    state: 'waiting',
  };
  links.set(link.id, link);
  return link;
};

/** The link an app waits on, by its id. */
export const appLinkById = (id: string): AppLink | undefined => {
  const link = links.get(id);
  return link && link.expiresAt > Date.now() ? link : undefined;
};

/** A link still waiting to be allowed, by the code its person typed. */
export const waitingAppLink = (typed: string): AppLink | undefined => {
  const code = normaliseCode(typed);
  const now = Date.now();
  return [...links.values()].find(
    (link) =>
      link.code === code && link.state === 'waiting' && link.expiresAt > now
  );
};

/** Hands the app its key, for it to collect once. */
export const approveAppLink = (
  link: AppLink,
  key: { secret: string; keyId: number; userId: number },
  now = Date.now()
): void => {
  link.state = 'approved';
  link.secret = key.secret;
  link.keyId = key.keyId;
  link.userId = key.userId;
  link.expiresAt = Math.max(link.expiresAt, now + COLLECT_WITHIN_MS);
};

export const declineAppLink = (link: AppLink): void => {
  link.state = 'declined';
};

/** Ends a link once the app has its answer. */
export const endAppLink = (link: AppLink): void => {
  links.delete(link.id);
};

export const secondsLeft = (link: AppLink, now = Date.now()): number =>
  Math.max(0, Math.ceil((link.expiresAt - now) / 1000));
