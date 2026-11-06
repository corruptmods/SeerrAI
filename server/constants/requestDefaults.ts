/** Kinds of server a default quality profile or folder mapping belongs to. */
export type ProfileService = 'radarr' | 'sonarr' | 'lidarr';

/**
 * A quality profile someone chose for their own requests to one server: for
 * anime when `anime` (Radarr and Sonarr only), else for everything else.
 */
export interface UserDefaultProfile {
  service: ProfileService;
  serverId: number;
  anime?: boolean;
  profileId: number;
}

/** A root folder a Radarr or Sonarr quality profile always goes to. */
export interface ProfileFolder {
  profileId: number;
  rootFolder: string;
}

const PROFILE_SERVICES: ProfileService[] = ['radarr', 'sonarr', 'lidarr'];

const isId = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

/**
 * Saved default profiles as stored: known services, whole ids, one per server
 * and kind (the last given wins), anime only where a server has it.
 */
export const cleanDefaultProfiles = (value: unknown): UserDefaultProfile[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const kept = new Map<string, UserDefaultProfile>();
  for (const entry of value as Partial<UserDefaultProfile>[]) {
    if (
      !entry ||
      !PROFILE_SERVICES.includes(entry.service as ProfileService) ||
      !isId(entry.serverId) ||
      !isId(entry.profileId) ||
      entry.profileId === 0
    ) {
      continue;
    }
    const anime = entry.service !== 'lidarr' && entry.anime === true;
    kept.set(`${entry.service}:${entry.serverId}:${anime}`, {
      service: entry.service as ProfileService,
      serverId: entry.serverId,
      ...(anime ? { anime } : {}),
      profileId: entry.profileId,
    });
  }
  return [...kept.values()];
};

/**
 * Profile-to-folder mappings as stored: whole profile ids and folder paths,
 * one folder per profile (the last given wins).
 */
export const cleanProfileFolders = (value: unknown): ProfileFolder[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const kept = new Map<number, ProfileFolder>();
  for (const entry of value as Partial<ProfileFolder>[]) {
    const rootFolder =
      typeof entry?.rootFolder === 'string' ? entry.rootFolder.trim() : '';
    if (!entry || !isId(entry.profileId) || !entry.profileId || !rootFolder) {
      continue;
    }
    kept.set(entry.profileId, { profileId: entry.profileId, rootFolder });
  }
  return [...kept.values()];
};

/** The folder a server maps a quality profile to, if any. */
export const mappedFolder = (
  server: { profileFolders?: ProfileFolder[] } | undefined,
  profileId: number | null | undefined
): string | undefined =>
  profileId
    ? server?.profileFolders?.find((entry) => entry.profileId === profileId)
        ?.rootFolder
    : undefined;
