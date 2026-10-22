import type {
  ApiKeyLifetime,
  ApiKeyStatus,
  ApiKeySummary,
} from '@server/constants/apiKeys';
import {
  API_KEY_PREFIX,
  PERSONAL_API_KEY_ACCESS,
} from '@server/constants/apiKeys';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import UserApiKey from '@server/entity/UserApiKey';
import { featureEnabled } from '@server/lib/features';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { maySignIn } from '@server/lib/signIn';
import { SignInLimiter } from '@server/lib/signInLimiter';
import logger from '@server/logger';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/*
 * Personal API keys: a key someone makes in their profile for an app or a
 * script, which then acts as them, with exactly their permissions.
 *
 * A key is `sai_`, an 8-character visible id, `_`, and 32 random bytes
 * (base64url). Only a SHA-256 hash of the whole key is kept: 256 random bits
 * need no slow hash, as there is nothing to guess from. A key is found by its
 * visible id and its hash compared in constant time, so neither the lookup
 * nor the comparison says anything about the secret. The `sai_` start lets
 * people (and secret scanners) recognise one; the visible id tells keys
 * apart in the list.
 *
 * Every use checks, besides the key itself: that it hasn't expired, that
 * keys are switched on (Settings → Users) and its owner may still have
 * them, and, every few minutes, that the owner could still sign in (a Plex
 * friend no longer shared with, a Jellyfin or Emby account switched off).
 * A key never acts for anyone else (no X-API-User), and can't make keys.
 *
 * A Siri key (scope 'siri', made on the Siri page) works only on
 * /api/v1/now-playing, and needs Siri reports on rather than keys.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Last used" is written at most this often. */
const RECORD_USE_EVERY_MS = 60 * 1000;
/** How long the answer to "could the owner still sign in?" is kept. */
const OWNER_CHECK_EVERY_MS = 10 * 60 * 1000;
/** How long that question may take before the key is let through. */
const OWNER_CHECK_TIMEOUT_MS = 10 * 1000;
/** The same refusal of the same key is logged at most this often. */
const REFUSAL_LOG_EVERY_MS = 15 * 60 * 1000;

/** Where a Siri key works: the now-playing routes. */
const SIRI_PATH = /^\/api\/v1\/now-playing(?:\/|$)/;

const KEY_PATTERN = /^sai_([0-9a-f]{8})_[A-Za-z0-9_-]{43}$/;

export const hashKey = (key: string): string =>
  createHash('sha256').update(key).digest('hex');

/** A new key, its visible id, and the hash that is kept of it. */
export const makeKey = (): {
  key: string;
  publicId: string;
  secretHash: string;
} => {
  const publicId = randomBytes(4).toString('hex');
  const key = `${API_KEY_PREFIX}${publicId}_${randomBytes(32).toString('base64url')}`;
  return { key, publicId, secretHash: hashKey(key) };
};

/** The visible id of something shaped like a personal key. */
export const publicIdOf = (value: string): string | undefined =>
  KEY_PATTERN.exec(value)?.[1];

/** Whether `key` is the one `secretHash` was made from, in constant time. */
export const keyMatches = (key: string, secretHash: string): boolean => {
  const given = Buffer.from(hashKey(key), 'hex');
  const kept = Buffer.from(secretHash, 'hex');
  return kept.length === given.length && timingSafeEqual(given, kept);
};

export const expiresAtFor = (
  days: ApiKeyLifetime,
  from: Date = new Date()
): Date | null =>
  days === null ? null : new Date(from.getTime() + days * DAY_MS);

export const isExpired = (
  expiresAt: Date | null | undefined,
  now: Date = new Date()
): boolean => !!expiresAt && expiresAt.getTime() <= now.getTime();

/** Whether "last used" is old enough to be written again. */
export const shouldRecordUse = (
  lastUsedAt: Date | null | undefined,
  now: Date = new Date()
): boolean =>
  !lastUsedAt || now.getTime() - lastUsedAt.getTime() >= RECORD_USE_EVERY_MS;

/**
 * Whether this person can use keys now: switched on for everyone, or for
 * admins and people who manage users and they are one. A setting this
 * version doesn't know counts as off.
 */
export const apiKeyStatus = (user: User): ApiKeyStatus => {
  const access = getSettings().main.personalApiKeys;
  if (!PERSONAL_API_KEY_ACCESS.includes(access) || access === 'off') {
    return 'off';
  }
  if (access === 'managers' && !user.hasPermission(Permission.MANAGE_USERS)) {
    return 'notAllowed';
  }
  return 'on';
};

/** A key as the pages see it: never the key or its hash. */
export const keySummary = (key: UserApiKey): ApiKeySummary => ({
  id: key.id,
  name: key.name,
  prefix: `${API_KEY_PREFIX}${key.publicId}`,
  createdAt: key.createdAt.toISOString(),
  expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null,
  lastUsedAt: key.lastUsedAt ? key.lastUsedAt.toISOString() : null,
  expired: isExpired(key.expiresAt),
});

/*
 * Wrong keys count toward the same kind of limit as wrong passwords: ten in
 * fifteen minutes from one address, then a wait. Wrong secrets for a real
 * key's id count against that id, and keys that don't exist (or aren't
 * shaped like one) count together, so someone guessing doesn't lock out the
 * real keys used from the same address, such as everyone behind one home
 * router. A key that is genuine but expired, or whose owner can no longer
 * use it, isn't a guess and doesn't count, so an app still sending an old
 * key locks nobody out.
 */
const limiter = new SignInLimiter('apiKey');
const NO_SUCH_KEY = 'no-such-key';

/** Whether each owner could still sign in, and when that was asked. */
const ownerChecks = new Map<number, { ok: boolean; at: number }>();
/** When each refusal was last logged. */
const refusalsLogged = new Map<string, number>();

/** Forgets what is kept in memory between requests. For tests. */
export const resetApiKeyMemoryForTests = (): void => {
  ownerChecks.clear();
  refusalsLogged.clear();
};

const ownerMaySignIn = async (user: User): Promise<boolean> => {
  const now = Date.now();
  const known = ownerChecks.get(user.id);
  if (known && now - known.at < OWNER_CHECK_EVERY_MS) {
    return known.ok;
  }
  // As with a password, a media server that can't be asked doesn't keep
  // anyone out: Plex being down shouldn't stop a script.
  let timer: NodeJS.Timeout | undefined;
  const ok = await Promise.race([
    maySignIn(user, 'password').catch(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), OWNER_CHECK_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  ownerChecks.set(user.id, { ok, at: now });
  return ok;
};

type Refusal =
  | 'malformed'
  | 'unknown'
  | 'expired'
  | 'switchedOff'
  | 'notAllowed'
  | 'ownerCannotSignIn'
  | 'actsForSomeoneElse'
  | 'outsideScope'
  | 'tooManyAttempts';

const logRefusal = (
  req: Request,
  reason: Refusal,
  details: { keyId?: number; publicId?: string; name?: string; userId?: number }
) => {
  const tag = `${details.publicId ?? req.ip ?? ''}:${reason}`;
  const now = Date.now();
  const last = refusalsLogged.get(tag);
  if (last && now - last < REFUSAL_LOG_EVERY_MS) {
    return;
  }
  if (refusalsLogged.size > 1000) {
    refusalsLogged.clear();
  }
  refusalsLogged.set(tag, now);
  logger.warn('API key refused', {
    label: 'API Key',
    reason,
    ...details,
    ip: req.ip,
  });
};

export type ApiKeyOutcome =
  | { user: User }
  | { status: 401 | 403 | 429; message: string; retryAfter?: number };

const INVALID = "This API key isn't valid. It may have been revoked.";

/**
 * Who a personal key in X-Api-Key acts as, or why it is refused. Anything
 * sent there that isn't the server's key comes here, so a wrong server's
 * key is refused (and counted) like a wrong personal one. The caller
 * answers a refusal and goes no further.
 */
export const authenticateApiKey = async (
  req: Request,
  value: string
): Promise<ApiKeyOutcome> => {
  const waitFor = (bucket: string): ApiKeyOutcome | undefined => {
    const wait = limiter.retryAfter(req, bucket);
    if (!wait) {
      return undefined;
    }
    logRefusal(req, 'tooManyAttempts', {});
    return {
      status: 429,
      message: 'Too many attempts. Try again in a few minutes.',
      retryAfter: wait,
    };
  };

  const publicId = publicIdOf(value);
  if (!publicId) {
    const waiting = waitFor(NO_SUCH_KEY);
    if (waiting) {
      return waiting;
    }
    limiter.count(req, NO_SUCH_KEY);
    logRefusal(req, 'malformed', {});
    return { status: 401, message: INVALID };
  }
  const waitingForKey = waitFor(publicId);
  if (waitingForKey) {
    return waitingForKey;
  }

  const key = await getRepository(UserApiKey).findOne({
    select: {
      id: true,
      publicId: true,
      secretHash: true,
      name: true,
      userId: true,
      expiresAt: true,
      lastUsedAt: true,
      scope: true,
    },
    where: { publicId },
  });
  if (!key) {
    const waiting = waitFor(NO_SUCH_KEY);
    if (waiting) {
      return waiting;
    }
    limiter.count(req, NO_SUCH_KEY);
    logRefusal(req, 'unknown', { publicId });
    return { status: 401, message: INVALID };
  }
  if (!keyMatches(value, key.secretHash)) {
    limiter.count(req, publicId);
    logRefusal(req, 'unknown', { publicId, keyId: key.id });
    return { status: 401, message: INVALID };
  }

  const details = {
    keyId: key.id,
    publicId,
    name: key.name,
    userId: key.userId,
  };
  if (isExpired(key.expiresAt)) {
    logRefusal(req, 'expired', details);
    return {
      status: 401,
      message: `This API key expired on ${key.expiresAt?.toISOString().slice(0, 10)}. Make a new one in your profile.`,
    };
  }

  const user = await getRepository(User).findOne({
    where: { id: key.userId },
  });
  if (!user) {
    // Keys go with their owner, so this is only a race with a deletion.
    logRefusal(req, 'unknown', details);
    return { status: 401, message: INVALID };
  }

  // A Siri key reports what is playing, and nothing else. It is for
  // whoever may report with Siri, whether or not they may make keys.
  if (key.scope === 'siri') {
    if (!SIRI_PATH.test(req.originalUrl.split('?')[0])) {
      logRefusal(req, 'outsideScope', details);
      return {
        status: 403,
        message: 'A Siri key only works for reporting with Siri.',
      };
    }
    if (!featureEnabled('siri', user)) {
      logRefusal(req, 'switchedOff', details);
      return { status: 401, message: 'Reporting with Siri is turned off.' };
    }
  }

  const status = key.scope === 'siri' ? 'on' : apiKeyStatus(user);
  if (status === 'off') {
    logRefusal(req, 'switchedOff', details);
    return {
      status: 401,
      message: 'Personal API keys are turned off on this server.',
    };
  }
  if (status === 'notAllowed') {
    logRefusal(req, 'notAllowed', details);
    return {
      status: 401,
      message: 'This account may no longer use API keys.',
    };
  }

  const actAs = req.header('X-API-User');
  if (actAs !== undefined && Number(actAs) !== user.id) {
    logRefusal(req, 'actsForSomeoneElse', details);
    return {
      status: 403,
      message:
        'A personal API key only ever acts as its owner. Leave out X-API-User.',
    };
  }

  if (!(await ownerMaySignIn(user))) {
    logRefusal(req, 'ownerCannotSignIn', details);
    return {
      status: 401,
      message: "This API key's owner can no longer sign in.",
    };
  }

  const now = new Date();
  if (shouldRecordUse(key.lastUsedAt, now)) {
    // A key that works isn't refused because this couldn't be written.
    await getRepository(UserApiKey)
      .update(key.id, { lastUsedAt: now })
      .catch((e) =>
        logger.debug('Could not record when an API key was used', {
          label: 'API Key',
          keyId: key.id,
          errorMessage: e instanceof Error ? e.message : String(e),
        })
      );
  }

  return { user };
};
