import SiloAPI, { SiloError, toSiloError } from '@server/api/silo/client';
import type {
  SiloAccount,
  SiloAccountProfile,
  SiloAdminUser,
} from '@server/api/silo/types';
import { hostnameFor } from '@server/lib/mediaServers';
import { getSettings } from '@server/lib/settings';
import type { SiloEpoch } from '@server/lib/silo';
import {
  SILO_RESETTING,
  SiloResettingError,
  siloClient,
  siloDeviceId,
  siloEpoch,
  siloEpochCurrent,
  siloResetPending,
} from '@server/lib/silo';
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
  | 'unreachable'
  | 'differentServer';

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

/** How long Silo's identity, once read, is trusted. */
const IDENTITY_MS = 60_000;
let identity: { hostname: string; serverId: string; at: number } | undefined;

/** For tests: reads Silo's identity afresh next time. */
export const resetSiloIdentityForTests = (): void => {
  identity = undefined;
};

export const DIFFERENT_SILO =
  'The Silo at this address is not the one Seerr AI was connected to, so Silo accounts are not accepted. An administrator must connect Silo again under Settings → Media Servers.';

/**
 * Refuses when the Silo answering at the saved address is not the one
 * Seerr AI connected to (a rebuilt server reuses small account ids, so an
 * old link would let someone else in). Read anonymously, at most once a
 * minute. Also refuses while a different Silo's reset is under way, as
 * the old links still name accounts the new Silo gives to others.
 */
export const assertSameSilo = async (): Promise<void> => {
  if (siloResetPending()) {
    throw new SiloSignInError(503, 'differentServer', SILO_RESETTING);
  }
  const expected = getSettings().silo.serverId;
  if (!expected) return;
  const hostname = hostnameFor('silo');
  let found =
    identity &&
    identity.hostname === hostname &&
    Date.now() - identity.at < IDENTITY_MS
      ? identity.serverId
      : undefined;
  if (!found) {
    try {
      found = (await openClient(hostname).getIdentity()).server_id;
    } catch (e) {
      throw signInFailure(e);
    }
    identity = { hostname, serverId: found, at: Date.now() };
  }
  // A reset may have begun while Silo was asked.
  if (siloResetPending()) {
    throw new SiloSignInError(503, 'differentServer', SILO_RESETTING);
  }
  if (found !== expected || getSettings().silo.serverId !== expected) {
    throw new SiloSignInError(409, 'differentServer', DIFFERENT_SILO);
  }
};

/**
 * Refuses, as the reset gate does, once a reset was marked since `epoch`
 * was taken: the account Silo named belongs to the old Silo. Checked after
 * Silo answers and before each read or write of what it said.
 */
export const assertSiloSignInEpoch = (epoch: SiloEpoch): void => {
  if (!siloEpochCurrent(epoch)) {
    throw new SiloSignInError(503, 'differentServer', SILO_RESETTING);
  }
};

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
  // At the saved address, only the Silo Seerr AI connected to, and only
  // if it still is once Silo answers.
  const epoch = hostname ? undefined : siloEpoch();
  if (!hostname) await assertSameSilo();
  const client = openClient(hostname);
  let tokens;
  try {
    tokens = await client.login(username, password, siloDeviceId());
  } catch (e) {
    throw signInFailure(e);
  }
  const account = await closeAndCheck(client, tokens);
  if (epoch) assertSiloSignInEpoch(epoch);
  return account;
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
  /** Who started it (their address group), so one can't crowd out others. */
  address: string;
}

const pending = new Map<string, PendingDevice>();
/** Most device sign-ins one address has waiting; its oldest go first. */
const MAX_PENDING_PER_ADDRESS = 5;
/** Most waiting at once from everyone, a memory bound; the oldest go first. */
const MAX_PENDING = 5000;

/** Drops expired sign-ins, and makes room for one more from `address`. */
const prunePending = (address: string, now = Date.now()) => {
  let fromAddress = 0;
  for (const [handle, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(handle);
    else if (entry.address === address) fromAddress += 1;
  }
  for (const [handle, entry] of pending) {
    if (fromAddress < MAX_PENDING_PER_ADDRESS) break;
    if (entry.address === address) {
      pending.delete(handle);
      fromAddress -= 1;
    }
  }
  for (const handle of pending.keys()) {
    if (pending.size < MAX_PENDING) break;
    pending.delete(handle);
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

/**
 * Starts a device sign-in, for signing in or for linking `userId`, from
 * `address` (addressGroupOf the request's).
 */
export const startSiloDevice = async (
  address: string,
  userId?: number
): Promise<SiloDeviceCode> => {
  let start;
  try {
    start = await openClient().startDeviceLogin();
  } catch (e) {
    throw signInFailure(e);
  }
  prunePending(address);
  const expiresAt =
    Date.parse(start.expires_at) ||
    Date.now() + Math.max(start.expires_in, 60) * 1000;
  const handle = randomBytes(24).toString('hex');
  pending.set(handle, {
    deviceCode: start.device_code,
    expiresAt,
    userId,
    address,
  });
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
  | {
      status: 'approved';
      account: SiloAccount;
      /** The Silo that approved it; checked before using the account. */
      epoch: SiloEpoch;
    }
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
  const epoch = siloEpoch();
  await assertSameSilo();
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
    assertSiloSignInEpoch(epoch);
    // Silo names a profile only for temporary sessions; the person picks
    // theirs under Linked Accounts.
    return { status: 'approved', account, epoch };
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

/**
 * Every account on Silo that may sign in (switched on). The caller takes a
 * siloEpoch first and checks it before matching them to accounts here.
 */
export const enabledSiloAccounts = async (): Promise<SiloAdminUser[]> => {
  // Old links would be matched against the new Silo's accounts.
  if (siloResetPending()) throw new SiloResettingError();
  const epoch = siloEpoch();
  const accounts = await siloClient().listAdminUsers();
  if (!siloEpochCurrent(epoch)) throw new SiloResettingError();
  return accounts.filter((account) => account.enabled !== false);
};

/** An account's household profiles, read with the server key. */
export const siloProfiles = (
  accountId: string
): Promise<SiloAccountProfile[]> =>
  siloClient({ timeout: 10_000 }).getAccountProfiles(accountId);

/** How long a picture lookup's profiles are reused. */
const PICTURE_PROFILES_TTL = 2 * 60 * 1000;

/** Forgets every account's profiles read for pictures (Silo replaced). */
export const forgetSiloPictures = (): void => pictureLookups.clear();

const pictureLookups = new Map<
  string,
  { at: number; profiles: Promise<SiloAccountProfile[]> }
>();

/**
 * An account's profiles for its picture: read once every couple of minutes
 * however often the picture is asked for, one read at a time per account,
 * and never waiting out a rate limit (a picture request mustn't hang). A
 * failed read isn't kept.
 */
export const siloProfilesForPicture = (
  accountId: string
): Promise<SiloAccountProfile[]> => {
  const now = Date.now();
  const known = pictureLookups.get(accountId);
  if (known && now - known.at < PICTURE_PROFILES_TTL) return known.profiles;
  for (const [id, entry] of pictureLookups) {
    if (now - entry.at >= PICTURE_PROFILES_TTL) pictureLookups.delete(id);
  }
  const profiles = siloClient({ timeout: 10_000 })
    .getAccountProfiles(accountId, { wait: false })
    .catch((e) => {
      if (pictureLookups.get(accountId)?.profiles === profiles) {
        pictureLookups.delete(accountId);
      }
      throw e;
    });
  pictureLookups.set(accountId, { at: now, profiles });
  return profiles;
};

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
