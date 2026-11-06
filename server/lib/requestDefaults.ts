import type { MediaType } from '@server/constants/media';
import type { ProfileService } from '@server/constants/requestDefaults';
import { mappedFolder } from '@server/constants/requestDefaults';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { chosenServerFor, defaultServerFor } from '@server/lib/requestServers';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { Repository } from 'typeorm';

/**
 * Whether someone may choose a request's server, quality profile, folder and
 * tags; everyone else gets the defaults.
 */
export const choosesAdvancedOptions = (user?: User | null): boolean =>
  !!user?.hasPermission(
    [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
    { type: 'or' }
  );

/**
 * The quality profile someone saved for their requests to a server, while
 * they may choose profiles. Anime uses their anime one only where the server
 * has an anime profile of its own, as anime routing does.
 */
export const savedProfileFor = (
  user: User | null | undefined,
  service: ProfileService,
  server: { id: number; activeAnimeProfileId?: number },
  anime = false
): number | undefined => {
  if (!choosesAdvancedOptions(user)) {
    return undefined;
  }
  const forAnime =
    service !== 'lidarr' && anime && !!server.activeAnimeProfileId;
  return user?.settings?.defaultProfiles?.find(
    (entry) =>
      entry.service === service &&
      entry.serverId === server.id &&
      !!entry.anime === forAnime
  )?.profileId;
};

/**
 * The requester's saved profile for a request sent without one, if they may
 * still choose profiles and the server still has it; else nothing, so the
 * server's default is used.
 */
export const requesterProfile = async ({
  userId,
  service,
  server,
  anime,
  profiles,
  users = getRepository(User),
}: {
  userId?: number;
  service: ProfileService;
  server: { id: number; name: string; activeAnimeProfileId?: number };
  anime?: boolean;
  /** The server's quality profiles, asked only when there is one to check. */
  profiles: () => Promise<{ id: number }[]>;
  /** Where to read the requester, e.g. inside the sending transaction. */
  users?: Pick<Repository<User>, 'findOne'>;
}): Promise<number | undefined> => {
  if (!userId) {
    return undefined;
  }
  const user = await users.findOne({ where: { id: userId } });
  const saved = savedProfileFor(user, service, server, anime);
  if (!saved) {
    return undefined;
  }
  try {
    if ((await profiles()).some((profile) => profile.id === saved)) {
      return saved;
    }
    logger.info(
      'The requester’s default quality profile is gone; using the server’s',
      { label: 'Media Request', server: server.name, profileId: saved }
    );
  } catch (e) {
    logger.warn('Could not check the requester’s default quality profile', {
      label: 'Media Request',
      server: server.name,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
  return undefined;
};

/**
 * The folder an edited movie or series request is saved with: the one its
 * quality profile maps to on its server, unless a request manager picked
 * another; else the folder given.
 */
export const editedRequestFolder = ({
  editor,
  type,
  serverId,
  is4k,
  profileId,
  rootFolder,
}: {
  editor?: User;
  type: MediaType;
  serverId?: number | null;
  is4k: boolean;
  profileId?: number | null;
  rootFolder?: string;
}): string | undefined => {
  if (rootFolder && editor?.hasPermission(Permission.MANAGE_REQUESTS)) {
    return rootFolder;
  }
  const server = (chosenServerFor({ type, serverId, is4k }) ??
    defaultServerFor({ type, is4k })) as
    | RadarrSettings
    | SonarrSettings
    | undefined;
  return mappedFolder(server, profileId) ?? rootFolder;
};
