import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import type { JellyfinFamilyKind } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import OidcLink from '@server/entity/OidcLink';
import { Session } from '@server/entity/Session';
import { User } from '@server/entity/User';
import {
  USER_ID,
  hostnameFor,
  isConnected,
  jellyfinFamily,
  linkedServers,
  signInAllowed,
} from '@server/lib/mediaServers';
import { getSettings } from '@server/lib/settings';
import type { Request } from 'express';
import { In, Like } from 'typeorm';

/**
 * Signs a user in on a brand-new session. The browser's existing session is
 * discarded first: a pre-sign-in session id (an abandoned passkey attempt, or
 * one planted by someone else) must never become a signed-in one.
 */
export const startSession = (req: Request, userId: number): Promise<void> =>
  new Promise((resolve, reject) => {
    // They just got in, so an earlier "no longer allowed" is out of date.
    if (stillAllowed.get(userId)?.ok === false) {
      stillAllowed.delete(userId);
    }
    if (!req.session) {
      resolve();
      return;
    }
    req.session.regenerate((error) => {
      if (error) {
        reject(error);
        return;
      }
      req.session.userId = userId;
      req.session.save((saveError) =>
        saveError ? reject(saveError) : resolve()
      );
    });
  });

/** Stored session lifetime: a month signed in, minutes otherwise. */
export const sessionTtlSeconds = (session: { userId?: number }): number =>
  session.userId ? 60 * 60 * 24 * 30 : 60 * 10;

/**
 * Whether this user may still sign in. A Plex account the owner stopped
 * sharing with is refused, as is a Jellyfin or Emby account deleted or
 * disabled there: neither a passkey nor a password overrides the media
 * server's decision.
 *
 * With accounts on several connected servers, any one still allowing them is
 * enough. Disconnected servers have no say: a user whose only accounts are
 * there signs in like a password account.
 *
 * A passkey stands in for media server sign-in, so it follows each server's
 * sign-in switch. Passwords have their own switch, checked where typed, and
 * the owner can always use theirs. On an account with no media server a
 * passkey stands in for the password and follows the password switch, unless
 * the account has an SSO link: then the passkey is proof on its own, and SSO
 * users keep it when passwords are off.
 *
 * `signedIn` asks whether someone already signed in may stay so: as for a
 * password, and a Jellyfin or Emby server Seerr has no API key for is no
 * answer either.
 */
export const maySignIn = async (
  user: Pick<
    User,
    'id' | 'userType' | 'plexId' | 'jellyfinUserId' | 'embyUserId'
  >,
  how: 'passkey' | 'password' | 'signedIn'
): Promise<boolean> => {
  const settings = getSettings();
  const asPassword = how !== 'passkey';

  if (asPassword && user.id === 1) {
    return true;
  }

  const linked = linkedServers(user);
  const live = linked.filter(isConnected);

  // A password account, or one whose servers are all disconnected.
  if (
    user.userType === UserType.LOCAL ||
    (linked.length > 0 && live.length === 0)
  ) {
    return (
      asPassword ||
      settings.main.localLogin !== false ||
      user.id === 1 ||
      (await getRepository(OidcLink).exists({
        where: { user: { id: user.id } },
      }))
    );
  }

  const servers =
    how === 'passkey' ? live.filter((kind) => signInAllowed(kind)) : live;
  if (servers.length === 0) {
    return false;
  }
  if (user.id === 1) {
    return true;
  }

  // Each server answers yes, no, or unreachable (undefined).
  let unknown = false;
  let failure: unknown;
  for (const kind of servers) {
    try {
      const answer =
        kind === 'plex'
          ? await plexLetsIn(user, how)
          : await jellyfinLetsIn(user, kind, how);
      if (answer) {
        return true;
      }
      if (answer === undefined) {
        unknown = true;
      }
    } catch (e) {
      unknown = true;
      failure ??= e;
    }
  }

  // A password is the way in while a media server is down, so an unreachable
  // server doesn't lock out someone who typed one.
  if (asPassword) {
    return unknown;
  }
  if (failure) {
    throw failure;
  }
  return false;
};

/** Whether the owner still shares their Plex server with the user. */
const plexLetsIn = async (
  user: Pick<User, 'plexId'>,
  how: 'passkey' | 'password' | 'signedIn'
): Promise<boolean | undefined> => {
  const owner = await getRepository(User).findOneOrFail({
    select: { id: true, plexToken: true, plexId: true },
    where: { id: 1 },
  });
  if (!user.plexId) {
    return false;
  }
  if (user.plexId === owner.plexId) {
    return true;
  }
  if (how === 'passkey') {
    return new PlexTvAPI(owner.plexToken ?? '').checkUserAccess(user.plexId);
  }
  // Refuse only when Plex says the server is no longer shared: Plex down, or
  // the owner's Plex sign-in lapsed, is no answer.
  return stillSharedOnPlex(
    owner.plexToken ?? '',
    user.plexId,
    how === 'signedIn'
  );
};

/**
 * Whether their Jellyfin or Emby account still exists and is enabled. Throws
 * when the server is unreachable.
 */
const jellyfinLetsIn = async (
  user: Pick<User, 'jellyfinUserId' | 'embyUserId'>,
  kind: JellyfinFamilyKind,
  how: 'passkey' | 'password' | 'signedIn'
): Promise<boolean | undefined> => {
  const accountId = user[USER_ID[kind]];
  const { apiKey } = jellyfinFamily(kind);
  if (!accountId) {
    return false;
  }
  if (!apiKey) {
    return how === 'signedIn' ? undefined : false;
  }
  const account = await new JellyfinAPI(
    hostnameFor(kind),
    apiKey,
    undefined,
    kind
  ).getAccount(accountId);
  return !!account && !account.Policy?.IsDisabled;
};

/** How long the owner's Plex share list is reused across users. */
const PLEX_USERS_EVERY_MS = 60 * 1000;
type SharedUsers = Awaited<
  ReturnType<PlexTvAPI['getUsers']>
>['MediaContainer']['User'];
let plexUsersCache:
  | { token: string; at: number; users: Promise<SharedUsers> }
  | undefined;

/**
 * The owner's Plex share list. Background checks of people already signed in
 * share one fetch; a sign-in always asks Plex afresh.
 */
const plexUsers = (
  ownerToken: string,
  reuse: boolean
): Promise<SharedUsers> => {
  const now = Date.now();
  if (
    reuse &&
    plexUsersCache?.token === ownerToken &&
    now - plexUsersCache.at < PLEX_USERS_EVERY_MS
  ) {
    return plexUsersCache.users;
  }
  const users = new PlexTvAPI(ownerToken)
    .getUsers()
    .then((response) => response.MediaContainer.User);
  plexUsersCache = { token: ownerToken, at: now, users };
  // A failed fetch is not reused.
  users.catch(() => {
    if (plexUsersCache?.users === users) {
      plexUsersCache = undefined;
    }
  });
  return users;
};

/**
 * Whether the server is still shared with this Plex account; undefined when
 * Plex is unreachable.
 */
const stillSharedOnPlex = async (
  ownerToken: string,
  plexId: number,
  reuse: boolean
): Promise<boolean | undefined> => {
  const machineId = getSettings().plex.machineId;
  if (!ownerToken || !machineId) {
    return undefined;
  }
  try {
    const users = await plexUsers(ownerToken, reuse);
    const shared = users.find((u) => parseInt(u.$.id) === plexId);
    return !!shared?.Server?.some(
      (server) => server.$.machineIdentifier === machineId
    );
  } catch {
    return undefined;
  }
};

/** How long a "may still sign in" answer is trusted. */
const STILL_ALLOWED_EVERY_MS = 10 * 60 * 1000;
/** After this long without an answer, the media server counts as unreachable. */
const STILL_ALLOWED_TIMEOUT_MS = 10 * 1000;

/** Whether each user may still sign in, and when that was asked. */
const stillAllowed = new Map<number, { ok: boolean; at: number }>();
/** Answers being fetched, so concurrent requests ask the media server once. */
const stillAllowedPending = new Map<number, Promise<boolean>>();

/** For tests: forgets every "may still sign in" answer. */
export const resetSignInMemoryForTests = (): void => {
  stillAllowed.clear();
  stillAllowedPending.clear();
  plexUsersCache = undefined;
};

/**
 * Whether someone already signed in, by session or personal key, may still
 * be, asked again every few minutes. A media server that is unreachable, slow
 * to answer or can't be asked counts as yes, so an outage signs nobody out.
 */
export const stillMaySignIn = (
  user: Pick<
    User,
    'id' | 'userType' | 'plexId' | 'jellyfinUserId' | 'embyUserId'
  >
): Promise<boolean> => {
  const known = stillAllowed.get(user.id);
  if (known && Date.now() - known.at < STILL_ALLOWED_EVERY_MS) {
    return Promise.resolve(known.ok);
  }
  const pending = stillAllowedPending.get(user.id);
  if (pending) {
    return pending;
  }

  const at = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const answer = Promise.race([
    maySignIn(user, 'signedIn').catch(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), STILL_ALLOWED_TIMEOUT_MS);
    }),
  ])
    .then((ok) => {
      if (stillAllowedPending.get(user.id) === answer) {
        stillAllowed.set(user.id, { ok, at });
      }
      return ok;
    })
    .finally(() => {
      clearTimeout(timer);
      if (stillAllowedPending.get(user.id) === answer) {
        stillAllowedPending.delete(user.id);
      }
    });
  stillAllowedPending.set(user.id, answer);
  return answer;
};

/**
 * As stillMaySignIn, without waiting on the media server: answers from the
 * last check (yes when there is none yet) and refreshes it in the background,
 * so a slow media server never delays a signed-in request.
 */
export const stillMaySignInNow = (
  user: Parameters<typeof stillMaySignIn>[0]
): boolean => {
  const known = stillAllowed.get(user.id);
  if (!known || Date.now() - known.at >= STILL_ALLOWED_EVERY_MS) {
    void stillMaySignIn(user);
  }
  return known?.ok ?? true;
};

/**
 * Signs a user out everywhere after a password change, or after a passkey,
 * single sign-on link or media server account is removed: whoever knew the
 * old password or held the device or account must not stay signed in. Also
 * once the media server stops letting them in. `keep` is the session the
 * change came from, when it was their own.
 *
 * Sessions are ended as the session store does (marked destroyed, not
 * deleted), so an in-flight request on one can't write it back.
 */
export const endSessions = async (
  userId: number,
  keep?: string
): Promise<void> => {
  const repository = getRepository(Session);
  // Narrowed in the database, then matched exactly: user 1's pattern also
  // matches user 12's sessions.
  const candidates = await repository.find({
    select: { id: true, json: true },
    where: { json: Like(`%"userId":${userId}%`) },
  });
  const ids = candidates
    .filter((session) => {
      if (session.id === keep) {
        return false;
      }
      try {
        return (
          (JSON.parse(session.json) as { userId?: unknown }).userId === userId
        );
      } catch {
        return false;
      }
    })
    .map((session) => session.id);
  if (ids.length > 0) {
    await repository.softDelete({ id: In(ids) });
  }
};
