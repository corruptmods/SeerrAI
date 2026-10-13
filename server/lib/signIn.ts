import JellyfinAPI from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { Session } from '@server/entity/Session';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { getHostname } from '@server/utils/getHostname';
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
 * A passkey stands in for signing in with the media server, so it also
 * follows that switch. A password has its own switch, checked where it is
 * typed, and the owner can always sign in with theirs.
 */
export const maySignIn = async (
  user: Pick<User, 'id' | 'userType' | 'plexId' | 'jellyfinUserId'>,
  how: 'passkey' | 'password'
): Promise<boolean> => {
  const settings = getSettings();

  if (how === 'password' && user.id === 1) {
    return true;
  }

  if (user.userType === UserType.PLEX) {
    if (how === 'passkey' && settings.main.mediaServerLogin === false) {
      return false;
    }
    if (user.id === 1) {
      return true;
    }
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
    // A password is the way in when Plex itself is down or the owner's
    // Plex sign-in has lapsed, so it is refused only when Plex answers
    // that the server is no longer shared with them.
    return (
      (await stillSharedOnPlex(owner.plexToken ?? '', user.plexId)) !== false
    );
  }

  if (user.userType === UserType.LOCAL) {
    return (
      how === 'password' || settings.main.localLogin !== false || user.id === 1
    );
  }

  if (how === 'passkey' && settings.main.mediaServerLogin === false) {
    return false;
  }
  if (user.id === 1) {
    return true;
  }
  // A Jellyfin or Emby account must still exist there, and not be switched
  // off.
  if (!user.jellyfinUserId || !settings.jellyfin.apiKey) {
    return false;
  }
  let account;
  try {
    account = await new JellyfinAPI(
      getHostname(),
      settings.jellyfin.apiKey
    ).getAccount(user.jellyfinUserId);
  } catch (e) {
    // The server could not be asked: a password still works then, as it
    // is the way in while the media server is down.
    if (how === 'password') {
      return true;
    }
    throw e;
  }
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
