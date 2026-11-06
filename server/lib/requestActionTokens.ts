import { getRepository } from '@server/datasource';
import type { MediaRequest } from '@server/entity/MediaRequest';
import UsedActionToken from '@server/entity/UsedActionToken';
import type { RequestAction } from '@server/lib/requestStatusChange';
import { REQUEST_ACTIONS } from '@server/lib/requestStatusChange';
import { getSettings } from '@server/lib/settings';
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { LessThan } from 'typeorm';

/*
 * Tokens for notification buttons that act without a session (ntfy's run on
 * the subscriber's phone). Each one is signed with a key derived from the
 * session secret, names one request as it was when the notification went
 * out, one action, the account it acts as and when it expires, and works
 * once: its random id is recorded when used.
 */

/** How long a button works, if the request is still waiting. */
export const ACTION_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** The only channel that hands these out so far. */
export type ActionTokenAgent = 'ntfy';

export interface ActionClaims {
  requestId: number;
  action: RequestAction;
  userId: number;
  agent: ActionTokenAgent;
  /** The request's requestFingerprint when the token was made. */
  requestState: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  /** Random; recorded once the token is used. */
  id: string;
}

/** Longer than any token made here; anything longer isn't read at all. */
export const ACTION_TOKEN_MAX_LENGTH = 512;

/**
 * What a request asks for: its kind and 4K, the server, profiles, folder and
 * tags it goes to, and its seasons, albums and songs. A pending request can
 * be edited after its notification went out; a button pressed after that
 * must not approve something its sender never saw.
 */
export const requestFingerprint = (
  request: Pick<
    MediaRequest,
    | 'type'
    | 'is4k'
    | 'serverId'
    | 'profileId'
    | 'rootFolder'
    | 'languageProfileId'
    | 'metadataProfileId'
    | 'seriesType'
    | 'tags'
    | 'seasons'
    | 'albums'
    | 'songs'
  >
): string => {
  const sorted = <T>(items: T[] | undefined, key: (item: T) => unknown) =>
    (items ?? []).map((item) => String(key(item))).sort();

  return createHash('sha256')
    .update(
      JSON.stringify([
        request.type,
        !!request.is4k,
        request.serverId ?? null,
        request.profileId ?? null,
        request.rootFolder || null,
        request.languageProfileId ?? null,
        request.metadataProfileId ?? null,
        request.seriesType ?? null,
        sorted(request.tags, (tag) => tag),
        sorted(request.seasons, (season) => season.seasonNumber),
        sorted(request.albums, (album) => album.albumMbid),
        sorted(request.songs, (song) => song.recordingMbid),
      ])
    )
    .digest('base64url')
    .slice(0, 22);
};

// Its own key, so a token can never pass for a session cookie or anything
// else signed with the secret.
const signingKey = () =>
  createHmac('sha256', getSettings().sessionSecret)
    .update('seerr-ai request action token v1')
    .digest();

const sign = (body: string) =>
  createHmac('sha256', signingKey()).update(body).digest();

export const signActionToken = (
  claims: Omit<ActionClaims, 'expiresAt' | 'id'>,
  now = Date.now()
): string => {
  const body = Buffer.from(
    JSON.stringify({
      r: claims.requestId,
      a: claims.action,
      u: claims.userId,
      g: claims.agent,
      s: claims.requestState,
      e: now + ACTION_TOKEN_LIFETIME_MS,
      n: randomBytes(16).toString('hex'),
    })
  ).toString('base64url');

  return `${body}.${sign(body).toString('base64url')}`;
};

/** The token's claims if it is genuine and unexpired; otherwise undefined. */
export const verifyActionToken = (
  token: unknown,
  now = Date.now()
): ActionClaims | undefined => {
  if (typeof token !== 'string' || token.length > ACTION_TOKEN_MAX_LENGTH) {
    return undefined;
  }

  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) {
    return undefined;
  }

  const expected = sign(body);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return undefined;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }

  const { r, a, u, g, s, e, n } = parsed ?? {};
  if (
    !Number.isSafeInteger(r) ||
    !REQUEST_ACTIONS.includes(a as RequestAction) ||
    !Number.isSafeInteger(u) ||
    g !== 'ntfy' ||
    typeof s !== 'string' ||
    !/^[\w-]{22}$/.test(s) ||
    typeof e !== 'number' ||
    typeof n !== 'string' ||
    !/^[0-9a-f]{32}$/.test(n)
  ) {
    return undefined;
  }

  if (e <= now) {
    return undefined;
  }

  return {
    requestId: r as number,
    action: a as RequestAction,
    userId: u as number,
    agent: g,
    requestState: s,
    expiresAt: e,
    id: n,
  };
};

/**
 * Records the token as used. False if it already was, so a second press, or a
 * copied request sent again, does nothing. Called under the request's lock
 * (each token names one request), so two presses at once take turns.
 */
export const spendActionToken = async (
  claims: ActionClaims,
  now = Date.now()
): Promise<boolean> => {
  const repository = getRepository(UsedActionToken);

  // Used tokens past their expiry would be refused anyway.
  await repository.delete({ expiresAt: LessThan(new Date(now)) });

  if (await repository.exists({ where: { id: claims.id } })) {
    return false;
  }

  try {
    await repository.insert({
      id: claims.id,
      expiresAt: new Date(claims.expiresAt),
    });
  } catch (e) {
    // Another server process on the same database got there first.
    if (await repository.exists({ where: { id: claims.id } })) {
      return false;
    }
    throw e;
  }

  return true;
};

/**
 * Takes back a spend whose change then failed to save, so the button can be
 * pressed again rather than being used up by an error.
 */
export const unspendActionToken = async (
  claims: ActionClaims
): Promise<void> => {
  await getRepository(UsedActionToken).delete({ id: claims.id });
};
