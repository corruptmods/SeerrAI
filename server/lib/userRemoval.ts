import PlexTvAPI from '@server/api/plextv';
import { SiloError } from '@server/api/silo/client';
import { USER_ID } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import RemovedPlexAccount from '@server/entity/RemovedPlexAccount';
import { User } from '@server/entity/User';
import type { JellyfinFamilyKind } from '@server/lib/mediaServers';
import { isConnected, jellyfinClient } from '@server/lib/mediaServers';
import { getSettings } from '@server/lib/settings';
import { endSessions } from '@server/lib/signIn';
import {
  SILO_NEEDS_USERS_SCOPE,
  siloClient,
  siloHasScope,
} from '@server/lib/silo';

/**
 * Deletes a Seerr AI account with its requests and sessions.
 *
 * keepOut stops the automatic Plex import from re-adding it; an account
 * removed for losing Plex access isn't kept out, so sharing with them again
 * brings it back.
 */
export const removeSeerrUser = async (
  user: User,
  { keepOut }: { keepOut: boolean }
): Promise<void> => {
  const requests =
    user.requests ??
    (await getRepository(MediaRequest).find({
      where: { requestedBy: { id: user.id } },
    }));

  // Remove requests explicitly: cascade deletes skip removal listeners, so
  // pending titles' Media would not revert to unknown.
  await getRepository(MediaRequest).remove(requests, {
    // Chunked, or over 1000 requests hits SQLite's "Expression tree is
    // too large". https://typeorm.io/repository-api#additional-options
    chunk: requests.length / 1000,
  });

  if (keepOut && user.plexId) {
    await getRepository(RemovedPlexAccount).upsert(
      { plexId: user.plexId },
      { conflictPaths: ['plexId'] }
    );
  }

  await getRepository(User).delete(user.id);
  // Their sessions go with them, should the id ever be used again.
  await endSessions(user.id);
};

/** Why an account couldn't be removed from its media server. */
export class MediaServerRemovalError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const jellyfinKindOf = (user: User): JellyfinFamilyKind | undefined =>
  user.userType === UserType.JELLYFIN
    ? 'jellyfin'
    : user.userType === UserType.EMBY
      ? 'emby'
      : undefined;

/**
 * Switches someone's Silo account off (admin:users scope): they can no
 * longer sign in to Silo, and their account and history stay there.
 */
const switchOffInSilo = async (user: User): Promise<string> => {
  if (!isConnected('silo')) {
    throw new MediaServerRemovalError(400, 'Silo is not connected.');
  }
  if (!user.siloUserId) {
    throw new MediaServerRemovalError(
      400,
      'This user has no Silo account to switch off.'
    );
  }
  if (!siloHasScope('admin:users')) {
    throw new MediaServerRemovalError(400, SILO_NEEDS_USERS_SCOPE);
  }
  const client = siloClient();
  let found;
  try {
    found = await client.getAdminUserForChange(user.siloUserId);
  } catch (e) {
    if (e instanceof SiloError && e.status === 404) return 'Silo';
    throw e;
  }
  if (found.account.role === 'admin') {
    throw new MediaServerRemovalError(
      409,
      'They are an administrator on Silo, so Seerr AI won’t switch them off.'
    );
  }
  if (found.account.enabled !== false) {
    try {
      await client.updateAdminUser(user.siloUserId, found.tag, {
        enabled: false,
      });
    } catch (e) {
      if (e instanceof SiloError && e.status === 403) {
        throw new MediaServerRemovalError(400, SILO_NEEDS_USERS_SCOPE);
      }
      throw e;
    }
  }
  return 'Silo';
};

/**
 * Takes someone off the media server their account comes from: ends their
 * Plex friendship, or disables their Jellyfin, Emby or Silo account. Returns
 * the server's name. Someone the server no longer has counts as done.
 */
export const removeFromMediaServer = async (user: User): Promise<string> => {
  if (user.userType === UserType.PLEX) {
    if (!isConnected('plex')) {
      throw new MediaServerRemovalError(400, 'Plex is not connected.');
    }
    if (!user.plexId) {
      throw new MediaServerRemovalError(
        400,
        'This user has no Plex account to remove.'
      );
    }
    const owner = await getRepository(User).findOne({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });
    if (!owner?.plexToken) {
      throw new MediaServerRemovalError(
        400,
        'Removing someone from Plex needs the owner’s Plex account: link it under Linked Accounts.'
      );
    }
    const plexTv = new PlexTvAPI(owner.plexToken);
    const entry = (await plexTv.getUsers()).MediaContainer?.User?.find(
      (u) => Number(u.$.id) === user.plexId
    );
    if (!entry) {
      return 'Plex';
    }
    if (entry.$.home === '1') {
      throw new MediaServerRemovalError(
        409,
        'They are in your Plex Home. Remove them from Plex Home in Plex.'
      );
    }
    await plexTv.removeFriend(user.plexId);
    return 'Plex';
  }

  if (user.userType === UserType.SILO) {
    return switchOffInSilo(user);
  }

  const kind = jellyfinKindOf(user);
  if (!kind) {
    throw new MediaServerRemovalError(
      400,
      'This user has no media server account.'
    );
  }
  const name = kind === 'emby' ? 'Emby' : 'Jellyfin';
  if (!isConnected(kind) || !getSettings()[kind].apiKey) {
    throw new MediaServerRemovalError(400, `${name} is not connected.`);
  }
  // Each server's own id: an Emby account has no Jellyfin id.
  const serverId = user[USER_ID[kind]];
  if (!serverId) {
    throw new MediaServerRemovalError(
      400,
      `This user has no ${name} account to disable.`
    );
  }
  const client = await jellyfinClient(kind);
  let account;
  try {
    account = await client.getPolicyAccount(serverId);
  } catch (e) {
    if (e.response?.status === 404 || e.response?.status === 400) {
      return name;
    }
    throw e;
  }
  if (account.Policy.IsAdministrator) {
    throw new MediaServerRemovalError(
      409,
      `They are an administrator on ${name}, so Seerr AI won’t disable them.`
    );
  }
  if (!account.Policy.IsDisabled) {
    await client.setPolicy(account.Id, {
      ...account.Policy,
      IsDisabled: true,
    });
  }
  return name;
};
