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
 * Signs someone in on a brand-new session. Whatever session the browser
 * brought is thrown away first: a session id that existed before signing in
 * (a passkey sign-in that was started and abandoned, or one planted by
 * someone else) must never become a signed-in one.
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

/** How long a stored session lasts: a month signed in, minutes otherwise. */
export const sessionTtlSeconds = (session: { userId?: number }): number =>
  session.userId ? 60 * 60 * 24 * 30 : 60 * 10;

/**
 * Whether this person may still sign in. A Plex account the server owner
 * has stopped sharing with is refused, so is a Jellyfin or Emby account
 * that has been deleted or switched off there: neither a passkey nor a
 * password is a way around the media server's own decision.
 *
 * Someone with accounts on several connected servers may sign in while any
 * one of them still lets them in. A server Seerr is no longer connected to
 * has no say: someone whose only accounts are there signs in as a password
 * account does.
 *
 * A passkey stands in for signing in with the media server, so it also
 * follows each server's sign-in switch. A password has its own switch,
 * checked where it is typed, and the owner can always sign in with theirs.
 * On an account with no media server, a passkey stands in for its
 * password, so it follows the password switch, unless the account has a
 * single sign-on link: a passkey is proof of its own, and people who sign
 * in with a provider keep theirs when passwords are switched off.
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

  // Each server answers yes, no, or could not be asked (undefined).
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

  // A password is the way in while a media server is down, so a server
  // that could not be asked does not keep anyone out who typed one.
  if (how === 'password') {
    return unknown;
  }
  if (failure) {
    throw failure;
  }
  return false;
};

/** Whether the server owner still shares their Plex server with them. */
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
  // Refused only when Plex answers that the server is no longer shared
  // with them: Plex down, or the owner's Plex sign-in lapsed, is no answer.
  return stillSharedOnPlex(owner.plexToken ?? '', user.plexId);
};

/**
 * Whether their Jellyfin or Emby account still exists there and is not
 * switched off. Throws when the server could not be asked.
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
 * Whether the server is still shared with this Plex account: true or false
 * when Plex answered, undefined when it could not be asked.
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
 * Signs someone out everywhere, after their password changed or one of
 * their passkeys was removed: whoever knew the old password or held the
 * device must not stay signed in. `keep` is the session the change was made
 * from, when it was their own.
 *
 * Sessions are ended the way the session store ends them (marked
 * destroyed, not deleted), so a request already under way on one of them
 * cannot write it back.
 */
export const endSessions = async (
  userId: number,
  keep?: string
): Promise<void> => {
  const repository = getRepository(Session);
  // Narrowed in the database, then read exactly: user 1's pattern also
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
