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
 */
export const maySignIn = async (
  user: Pick<
    User,
    'id' | 'userType' | 'plexId' | 'jellyfinUserId' | 'embyUserId'
  >,
  how: 'passkey' | 'password'
): Promise<boolean> => {
  const settings = getSettings();

  if (how === 'password' && user.id === 1) {
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
      how === 'password' ||
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
          : await jellyfinLetsIn(user, kind);
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
  if (how === 'password') {
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
  how: 'passkey' | 'password'
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
  return stillSharedOnPlex(owner.plexToken ?? '', user.plexId);
};

/**
 * Whether their Jellyfin or Emby account still exists and is enabled. Throws
 * when the server is unreachable.
 */
const jellyfinLetsIn = async (
  user: Pick<User, 'jellyfinUserId' | 'embyUserId'>,
  kind: JellyfinFamilyKind
): Promise<boolean> => {
  const accountId = user[USER_ID[kind]];
  const { apiKey } = jellyfinFamily(kind);
  if (!accountId || !apiKey) {
    return false;
  }
  const account = await new JellyfinAPI(
    hostnameFor(kind),
    apiKey,
    undefined,
    kind
  ).getAccount(accountId);
  return !!account && !account.Policy?.IsDisabled;
};

/**
 * Whether the server is still shared with this Plex account; undefined when
 * Plex is unreachable.
 */
const stillSharedOnPlex = async (
  ownerToken: string,
  plexId: number
): Promise<boolean | undefined> => {
  const machineId = getSettings().plex.machineId;
  if (!ownerToken || !machineId) {
    return undefined;
  }
  try {
    const users = (await new PlexTvAPI(ownerToken).getUsers()).MediaContainer
      .User;
    const shared = users.find((u) => parseInt(u.$.id) === plexId);
    return !!shared?.Server?.some(
      (server) => server.$.machineIdentifier === machineId
    );
  } catch {
    return undefined;
  }
};

/**
 * Signs a user out everywhere after a password change or passkey removal:
 * whoever knew the old password or held the device must not stay signed in.
 * `keep` is the session the change came from, when it was their own.
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
