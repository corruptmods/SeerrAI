import SiloAPI, { SiloError, toSiloError } from '@server/api/silo/client';
import type {
  SiloAccount,
  SiloAccountProfile,
  SiloAdminUser,
} from '@server/api/silo/types';
import { hostnameFor } from '@server/lib/mediaServers';
import { getSettings } from '@server/lib/settings';
import { siloClient, siloDeviceId } from '@server/lib/silo';
import { createHash, randomBytes } from 'node:crypto';

/*
 * People and Silo: signing in with a Silo account (a password, or a code
 * approved in Silo), whether Silo still lets an account in, and an account's
 * household profiles and picture. Seerr AI never keeps a Silo sign-in: every
 * session it opens is closed again at once.
 */

/** Why signing in with Silo failed. */
export type SiloSignInReason =
  | 'credentials'
  | 'passwordChange'
  | 'rateLimited'
  | 'notAdmin'
  | 'unreachable';

/** A failed Silo sign-in, with a status and a plain message. */
export class SiloSignInError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: SiloSignInReason,
    message: string
  ) {
    super(message);
    this.name = 'SiloSignInError';
  }
}

const PASSWORD_CHANGE =
  'This Silo account has a temporary password. Sign in to Silo, change it, then try again.';

/** A Silo failure during sign-in as a SiloSignInError. */
export const signInFailure = (e: unknown): SiloSignInError => {
  if (e instanceof SiloSignInError) return e;
  const error = toSiloError(e);
  if (error.code === 'password_change_required') {
    return new SiloSignInError(403, 'passwordChange', PASSWORD_CHANGE);
  }
  switch (error.status) {
    case 400:
    case 401:
    case 422:
      return new SiloSignInError(
        401,
        'credentials',
        'The username or password is incorrect.'
      );
    case 429:
      return new SiloSignInError(
        429,
        'rateLimited',
        'Silo has paused sign-in for this name after too many tries. Try again in a few minutes.'
      );
    default:
      return new SiloSignInError(
        502,
        'unreachable',
        "Seerr AI couldn't reach Silo. Try again in a moment."
      );
  }
};

/** A client for Silo's public sign-in routes, at its saved address. */
const openClient = (hostname = hostnameFor('silo')) =>
  new SiloAPI(hostname, undefined, { timeout: 15_000 });

/** The account an approved sign-in belongs to, after closing its session. */
const closeAndCheck = async (
  client: SiloAPI,
  tokens: { access_token: string; user: SiloAccount }
): Promise<SiloAccount> => {
  await client.logout(tokens.access_token);
  if (tokens.user.password_change_required) {
    throw new SiloSignInError(403, 'passwordChange', PASSWORD_CHANGE);
  }
  return tokens.user;
};

/**
 * Signs in to Silo with a name and password (Silo routes the name to its
 * local password or its LDAP directory) and signs out again at once.
 */
export const siloPasswordSignIn = async (
  username: string,
  password: string,
  hostname?: string
): Promise<SiloAccount> => {
  const client = openClient(hostname);
  let tokens;
  try {
    tokens = await client.login(username, password, siloDeviceId());
  } catch (e) {
    throw signInFailure(e);
  }
  return closeAndCheck(client, tokens);
};

/*
 * Device sign-in, the Quick Connect of Silo: Seerr AI asks Silo for a code,
 * the person approves it in Silo (where any way they sign in there works),
 * and Seerr AI collects the answer. Silo's device code is a secret, so the
 * page only gets a random handle for it, tied to who started it.
 */

interface PendingDevice {
  deviceCode: string;
  expiresAt: number;
  /** The signed-in user linking Silo; undefined for a sign-in. */
  userId?: number;
}

const pending = new Map<string, PendingDevice>();
/** Most device sign-ins waiting at once; the oldest go first. */
const MAX_PENDING = 500;

const prunePending = (now = Date.now()) => {
  for (const [handle, entry] of pending) {
    if (entry.expiresAt <= now || pending.size > MAX_PENDING) {
      pending.delete(handle);
    }
  }
};

/** For tests: forgets every waiting device sign-in. */
export const resetSiloDevicesForTests = (): void => pending.clear();

/** What the page shows while a device sign-in waits. */
export interface SiloDeviceCode {
  /** Seerr AI's handle for this sign-in; not Silo's secret. */
  handle: string;
  /** The code to approve, e.g. 4821-7730. */
  userCode: string;
  /** Silo's page to approve it on, the code filled in. */
  verificationUrl: string;
  /** Seconds until the code expires. */
  expiresIn: number;
  /** Seconds between checks. */
  interval: number;
}

/**
 * Silo's approval page at the address people use: Silo names its own public
 * address when it has one, else the one Seerr AI reached it at, which is
 * swapped for Silo's external URL when one is set here.
 */
const peopleAddress = (url: string): string => {
  const external = getSettings().silo.externalHostname?.replace(/\/+$/, '');
  const internal = hostnameFor('silo').replace(/\/+$/, '');
  if (!external) return url;
  try {
    const at = new URL(url);
    const reached = new URL(`${internal}/`);
    if (at.origin !== reached.origin) return url;
    const base = reached.pathname.replace(/\/+$/, '');
    const rest = at.pathname.startsWith(base)
      ? at.pathname.slice(base.length)
      : at.pathname;
    return `${external}${rest}${at.search}`;
  } catch {
    return url;
  }
};

/** Starts a device sign-in, for signing in or for linking `userId`. */
export const startSiloDevice = async (
  userId?: number
): Promise<SiloDeviceCode> => {
  let start;
  try {
    start = await openClient().startDeviceLogin();
  } catch (e) {
    throw signInFailure(e);
  }
  prunePending();
  const expiresAt =
    Date.parse(start.expires_at) ||
    Date.now() + Math.max(start.expires_in, 60) * 1000;
  const handle = randomBytes(24).toString('hex');
  pending.set(handle, { deviceCode: start.device_code, expiresAt, userId });
  return {
    handle,
    userCode: start.user_code,
    verificationUrl: peopleAddress(start.verification_uri_complete),
    expiresIn: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
    interval: Math.max(2, start.interval || 5),
  };
};

/** Where a device sign-in stands. */
export type SiloDeviceCheck =
  | { status: 'pending'; opened: boolean }
  | { status: 'approved'; account: SiloAccount; profileId: string | null }
  | { status: 'denied' | 'expired' };

/**
 * Asks Silo about a device sign-in started by the same person (`userId`, or
 * no one). An approval comes once: its session is closed and the handle
 * forgotten.
 */
export const checkSiloDevice = async (
  handle: string,
  userId?: number
): Promise<SiloDeviceCheck> => {
  const entry = pending.get(handle);
  if (!entry || entry.userId !== userId) {
    return { status: 'expired' };
  }
  if (entry.expiresAt <= Date.now()) {
    pending.delete(handle);
    return { status: 'expired' };
  }
  const client = openClient();
  let poll;
  try {
    poll = await client.pollDeviceLogin(entry.deviceCode, siloDeviceId());
  } catch (e) {
    const error = toSiloError(e);
    if (error.status === 404 || error.status === 410) {
      pending.delete(handle);
      return { status: 'expired' };
    }
    throw signInFailure(e);
  }
  if (poll.status === 'pending') {
    const later = Date.parse(poll.expires_at ?? '');
    if (later > entry.expiresAt) entry.expiresAt = later;
    return { status: 'pending', opened: !!poll.opened };
  }
  pending.delete(handle);
  if (poll.status === 'approved' && poll.tokens) {
    const account = await closeAndCheck(client, poll.tokens);
    return {
      status: 'approved',
      account,
      profileId: poll.profile_id || null,
    };
  }
  return { status: poll.status === 'denied' ? 'denied' : 'expired' };
};

/** Withdraws a device sign-in the same person started. */
export const cancelSiloDevice = async (
  handle: string,
  userId?: number
): Promise<void> => {
  const entry = pending.get(handle);
  if (!entry || entry.userId !== userId) return;
  pending.delete(handle);
  await openClient().cancelDeviceLogin(entry.deviceCode);
};

/**
 * Whether Silo still lets this account in: false when Silo has no such
 * account or it is switched off. Throws when Silo can't be asked.
 */
export const siloAccountAllowed = async (
  accountId: string
): Promise<boolean> => {
  try {
    const account = await siloClient({ timeout: 10_000 }).getAdminUser(
      accountId
    );
    return account.enabled !== false;
  } catch (e) {
    if (e instanceof SiloError && e.status === 404) return false;
    throw e;
  }
};

/** Every account on Silo that may sign in (switched on). */
export const enabledSiloAccounts = async (): Promise<SiloAdminUser[]> =>
  (await siloClient().listAdminUsers()).filter(
    (account) => account.enabled !== false
  );

/** An account's household profiles, read with the server key. */
export const siloProfiles = (
  accountId: string
): Promise<SiloAccountProfile[]> =>
  siloClient({ timeout: 10_000 }).getAccountProfiles(accountId);

/**
 * The profile a person's picture comes from: the one they chose, else the
 * household's primary profile, else the first.
 */
export const pictureProfile = (
  profiles: SiloAccountProfile[],
  chosen?: string | null
): SiloAccountProfile | undefined =>
  profiles.find((profile) => profile.id === chosen) ??
  profiles.find((profile) => profile.is_primary) ??
  profiles[0];

/**
 * A short tag for the picture a profile shows: it changes when the picture
 * does (Silo's avatar reference), not when its signed address does. Empty
 * when there is no picture.
 */
export const pictureVersion = (profile?: SiloAccountProfile): string =>
  profile?.avatar && profile.avatar_url
    ? createHash('sha256')
        .update(`${profile.id}|${profile.avatar}`)
        .digest('hex')
        .slice(0, 16)
    : '';

/** The address of a Silo account's picture here. */
export const siloAvatarPath = (
  accountId: string,
  version?: string | null
): string =>
  `/avatarproxy/silo/${encodeURIComponent(accountId)}${
    version ? `?v=${version}` : ''
  }`;
