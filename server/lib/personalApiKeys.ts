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
 * Personal API keys: made in a user's profile for an app or script, acting
 * as that user with exactly their permissions.
 *
 * Format: `sai_`, an 8-character public id, `_`, 32 random bytes
 * (base64url). Only a SHA-256 hash of the whole key is stored; 256 random
 * bits need no slow hash. Lookup is by public id with a constant-time hash
 * compare, so neither leaks the secret. The `sai_` prefix lets people (and
 * secret scanners) recognise keys; the public id distinguishes them in the
 * list.
 *
 * Every use also checks: not expired, keys enabled (Settings → Users) and
 * still allowed for the owner, and every few minutes that the owner could
 * still sign in (a Plex friend unshared, a Jellyfin or Emby account
 * disabled). A key never acts for anyone else (no X-API-User) and can't
 * create keys.
 *
 * A Siri key (scope 'siri', made on the Siri page) works only on
 * /api/v1/now-playing and requires Siri reports, not keys, to be on.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Minimum interval between "last used" writes. */
const RECORD_USE_EVERY_MS = 60 * 1000;
/** Cache lifetime for "could the owner still sign in?". */
const OWNER_CHECK_EVERY_MS = 10 * 60 * 1000;
/** Owner check timeout, after which the key is let through. */
const OWNER_CHECK_TIMEOUT_MS = 10 * 1000;
/** Minimum interval between logs of the same refusal for the same key. */
const REFUSAL_LOG_EVERY_MS = 15 * 60 * 1000;

/** Siri keys work only on the now-playing routes. */
const SIRI_PATH = /^\/api\/v1\/now-playing(?:\/|$)/;

const KEY_PATTERN = /^sai_([0-9a-f]{8})_[A-Za-z0-9_-]{43}$/;

export const hashKey = (key: string): string =>
  createHash('sha256').update(key).digest('hex');

/** A new key, its public id, and its stored hash. */
export const makeKey = (): {
  key: string;
  publicId: string;
  secretHash: string;
} => {
  const publicId = randomBytes(4).toString('hex');
  const key = `${API_KEY_PREFIX}${publicId}_${randomBytes(32).toString('base64url')}`;
  return { key, publicId, secretHash: hashKey(key) };
};

/** The public id of a value shaped like a personal key. */
export const publicIdOf = (value: string): string | undefined =>
  KEY_PATTERN.exec(value)?.[1];

/** Whether `key` hashes to `secretHash`, in constant time. */
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

/** Whether "last used" is stale enough to write again. */
export const shouldRecordUse = (
  lastUsedAt: Date | null | undefined,
  now: Date = new Date()
): boolean =>
  !lastUsedAt || now.getTime() - lastUsedAt.getTime() >= RECORD_USE_EVERY_MS;

/**
 * Whether this user can use keys now: enabled for everyone, or for admins and
 * user managers and they are one. An unknown setting value counts as off.
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

/** A key as pages see it: never the key or its hash. */
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
 * Wrong keys share the password rate limit: ten in fifteen minutes per
 * address, then a wait. Wrong secrets for a real key id count against that
 * id; nonexistent or malformed keys count together, so a guesser doesn't lock
 * out real keys from the same address (e.g. everyone behind one home router).
 * A genuine key that is expired or no longer usable by its owner isn't a
 * guess and doesn't count, so an app sending an old key locks nobody out.
 */
const limiter = new SignInLimiter('apiKey');
const NO_SUCH_KEY = 'no-such-key';

/** Whether each owner could still sign in, and when that was checked. */
const ownerChecks = new Map<number, { ok: boolean; at: number }>();
/** When each refusal was last logged. */
const refusalsLogged = new Map<string, number>();

/** For tests: clears in-memory state. */
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
  // As with passwords, an unreachable media server doesn't lock anyone out:
  // Plex being down shouldn't stop a script.
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
 * there that isn't the server key comes here, so a wrong server key is
 * refused (and counted) like a wrong personal one. The caller sends the
 * refusal and stops.
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
    // Keys are deleted with their owner, so this is only a race with a
    // deletion.
    logRefusal(req, 'unknown', details);
    return { status: 401, message: INVALID };
  }

  // A Siri key only reports what is playing, for anyone allowed to report via
  // Siri, whether or not they may make keys. Any non-null scope is limited, and
  // an unknown scope works nowhere: a key never does more than it was made for.
  if (key.scope) {
    if (key.scope !== 'siri') {
      logRefusal(req, 'outsideScope', details);
      return { status: 403, message: 'This API key cannot be used here.' };
    }
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

  const status = key.scope ? 'on' : apiKeyStatus(user);
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
    // A failed write never refuses a working key.
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
