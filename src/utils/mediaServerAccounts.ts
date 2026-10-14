import type { MediaServerKind } from '@server/constants/server';
import { UserType } from '@server/constants/user';

/*
 * Which media servers someone has accounts on, and which of them Seerr is
 * connected to, for the pages that show or use them: sign-in, linked
 * accounts, the user list and the profile.
 */

/** Each server's name, as people know it. */
export const SERVER_NAMES: Record<MediaServerKind, string> = {
  plex: 'Plex',
  jellyfin: 'Jellyfin',
  emby: 'Emby',
};

const KIND_OF_USER_TYPE: Partial<Record<number, MediaServerKind>> = {
  [UserType.PLEX]: 'plex',
  [UserType.JELLYFIN]: 'jellyfin',
  [UserType.EMBY]: 'emby',
};

/** The server that holds someone's main account; none for a password one. */
export const mainServerOf = (user: {
  userType: number;
}): MediaServerKind | undefined => KIND_OF_USER_TYPE[user.userType];

interface PersonWithAccounts {
  userType: number;
  linkedServers?: MediaServerKind[];
}

/**
 * The servers someone has accounts on, their main one first. An answer from
 * before people could have several only says their main one.
 */
export const accountServers = (user: PersonWithAccounts): MediaServerKind[] => {
  const main = mainServerOf(user);
  const linked = user.linkedServers ?? (main ? [main] : []);
  return [
    ...(main && linked.includes(main) ? [main] : []),
    ...linked.filter((kind) => kind !== main),
  ];
};

/** Of someone's accounts, those on servers Seerr is connected to now. */
export const connectedAccountServers = (
  user: PersonWithAccounts,
  mediaServers: { kind: MediaServerKind }[]
): MediaServerKind[] =>
  accountServers(user).filter((kind) =>
    mediaServers.some((server) => server.kind === kind)
  );

/** The servers people may sign in with, the primary one first. */
export const signInServers = (settings: {
  mediaServerLogin: boolean;
  mediaServers: { kind: MediaServerKind; signIn: boolean }[];
}): MediaServerKind[] =>
  settings.mediaServerLogin
    ? settings.mediaServers
        .filter((server) => server.signIn)
        .map((server) => server.kind)
    : [];
