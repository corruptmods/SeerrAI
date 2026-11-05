import type { MediaServerKind } from '@server/constants/server';
import { UserType } from '@server/constants/user';

/*
 * A user's media server accounts and which servers Seerr is connected to, for
 * sign-in, linked accounts, the user list and the profile.
 */

/** Display name per server kind. */
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

/** The server of a user's main account; none for a password account. */
export const mainServerOf = (user: {
  userType: number;
}): MediaServerKind | undefined => KIND_OF_USER_TYPE[user.userType];

interface PersonWithAccounts {
  userType: number;
  linkedServers?: MediaServerKind[];
}

/** Servers the user has accounts on, main first. Older responses list only the main one. */
export const accountServers = (user: PersonWithAccounts): MediaServerKind[] => {
  const main = mainServerOf(user);
  const linked = user.linkedServers ?? (main ? [main] : []);
  return [
    ...(main && linked.includes(main) ? [main] : []),
    ...linked.filter((kind) => kind !== main),
  ];
};

/** Whether the user has a linked account on this server, connected or not. */
export const hasAccountOn = (
  user: PersonWithAccounts | undefined,
  kind: MediaServerKind
): boolean => !!user && accountServers(user).includes(kind);

/** The user's account servers that Seerr is currently connected to. */
export const connectedAccountServers = (
  user: PersonWithAccounts,
  mediaServers: { kind: MediaServerKind }[]
): MediaServerKind[] =>
  accountServers(user).filter((kind) =>
    mediaServers.some((server) => server.kind === kind)
  );

/** Servers allowed for sign-in, primary first. */
export const signInServers = (settings: {
  mediaServerLogin: boolean;
  mediaServers: { kind: MediaServerKind; signIn: boolean }[];
}): MediaServerKind[] =>
  settings.mediaServerLogin
    ? settings.mediaServers
        .filter((server) => server.signIn)
        .map((server) => server.kind)
    : [];
