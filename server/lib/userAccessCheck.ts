import PlexTvAPI from '@server/api/plextv';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type { MediaServerKind } from '@server/lib/mediaServers';
import {
  connectedServers,
  jellyfinClient,
  serverName,
} from '@server/lib/mediaServers';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { removeSeerrUser } from '@server/lib/userRemoval';
import logger from '@server/logger';
import { normalizeJellyfinGuid } from '@server/utils/jellyfin';

/*
 * With Remove Users Who Lose Access on, deletes the accounts of people the
 * media server no longer has: no longer shared on the Plex server, or deleted
 * from Jellyfin or Emby. Someone must be missing on two checks in a row, so
 * one odd reply can't remove anyone, and a check that would remove every
 * account of a server removes none. The owner and admins are never removed.
 */

const TYPES: Record<MediaServerKind, UserType> = {
  plex: UserType.PLEX,
  jellyfin: UserType.JELLYFIN,
  emby: UserType.EMBY,
};

/** The server's own id for an account here, comparable with presentOn's. */
const serverIdOf = (kind: MediaServerKind, user: User): string | null =>
  kind === 'plex'
    ? user.plexId
      ? String(user.plexId)
      : null
    : normalizeJellyfinGuid(user.jellyfinUserId);

/** Everyone the server still has, by serverIdOf. Throws if it can't tell. */
const presentOn = async (kind: MediaServerKind): Promise<Set<string>> => {
  if (kind === 'plex') {
    const { machineId } = getSettings().plex;
    const owner = await getRepository(User).findOne({
      select: { id: true, plexToken: true },
      where: { id: 1 },
    });
    if (!machineId || !owner?.plexToken) {
      throw new Error('The owner’s Plex account is not linked.');
    }
    const response = await new PlexTvAPI(owner.plexToken).getUsers();
    if (!response?.MediaContainer) {
      throw new Error('Plex sent no user list.');
    }
    return new Set(
      (response.MediaContainer.User ?? [])
        .filter((user) =>
          user.Server?.some(
            (server) => server.$.machineIdentifier === machineId
          )
        )
        .map((user) => user.$.id)
    );
  }

  if (!getSettings()[kind].apiKey) {
    throw new Error(`${serverName(kind)} has no API key in Seerr AI.`);
  }
  const accounts = await (await jellyfinClient(kind)).getAccounts();
  // A server always has its own admin, so none means a bad reply.
  if (!accounts.length) {
    throw new Error(`${serverName(kind)} sent no accounts.`);
  }
  return new Set(
    accounts
      .map((account) => normalizeJellyfinGuid(account.Id))
      .filter((id): id is string => !!id)
  );
};

class UserAccessCheck {
  public running = false;
  /** Accounts found missing on the last check. */
  private missing = new Set<number>();

  /** Returns how many accounts were removed. */
  public async run(): Promise<number> {
    if (this.running) {
      return 0;
    }
    if (!getSettings().main.removeUsersWithoutAccess) {
      this.missing.clear();
      return 0;
    }
    this.running = true;

    try {
      const missingNow = new Set<number>();

      for (const kind of connectedServers()) {
        let present: Set<string>;
        try {
          present = await presentOn(kind);
        } catch (e) {
          // Nobody counts as missing from a server that couldn't be read.
          logger.warn(
            `Could not check who still has ${serverName(kind)}; nobody is removed for it this time`,
            {
              label: 'User Access Check',
              errorMessage: e instanceof Error ? e.message : String(e),
            }
          );
          continue;
        }

        const users = (
          await getRepository(User).find({
            select: {
              id: true,
              plexId: true,
              jellyfinUserId: true,
              permissions: true,
              userType: true,
            },
            where: { userType: TYPES[kind] },
          })
        ).filter(
          (user) =>
            user.id !== 1 &&
            !user.hasPermission(Permission.ADMIN) &&
            serverIdOf(kind, user)
        );
        const gone = users.filter(
          (user) => !present.has(serverIdOf(kind, user) as string)
        );

        if (gone.length > 1 && gone.length === users.length) {
          logger.warn(
            `Every ${serverName(kind)} user looks gone, which is more likely a problem with ${serverName(kind)}; nobody is removed`,
            { label: 'User Access Check', users: gone.length }
          );
          continue;
        }
        for (const user of gone) {
          missingNow.add(user.id);
          if (!this.missing.has(user.id)) {
            logger.info(
              `A user no longer has ${serverName(kind)} access; removed at the next check unless that changes`,
              { label: 'User Access Check', userId: user.id }
            );
          }
        }
      }

      const confirmed = [...missingNow].filter((id) => this.missing.has(id));
      this.missing = missingNow;

      let removed = 0;
      for (const id of confirmed) {
        const user = await getRepository(User).findOne({
          where: { id },
          relations: { requests: true },
        });
        // Gone already, or made an admin since.
        if (!user || user.hasPermission(Permission.ADMIN)) {
          continue;
        }
        try {
          await removeSeerrUser(user, { keepOut: false });
          this.missing.delete(id);
          removed++;
          logger.info(
            'Removed a user who no longer has access to the media server',
            {
              label: 'User Access Check',
              userId: user.id,
              username: user.displayName,
            }
          );
        } catch (e) {
          logger.error('Could not remove a user who lost access', {
            label: 'User Access Check',
            userId: user.id,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return removed;
    } finally {
      this.running = false;
    }
  }
}

const userAccessCheck = new UserAccessCheck();

export default userAccessCheck;
