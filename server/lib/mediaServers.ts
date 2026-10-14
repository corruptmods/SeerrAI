import JellyfinAPI from '@server/api/jellyfin';
import type {
  JellyfinFamilyKind,
  MediaServerKind,
} from '@server/constants/server';
import {
  AUTH_TOKEN,
  DEVICE_ID,
  MEDIA_ID,
  MEDIA_SERVER_KINDS,
  USERNAME,
  USER_ID,
  isJellyfinFamily,
  kindOfType,
  typeOfKind,
} from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type { JellyfinSettings } from '@server/lib/settings';
import { connectedKindsOf, getSettings } from '@server/lib/settings';

/*
 * Which media servers Seerr is connected to, and where each keeps its
 * settings and its ids. Code that works with a media server asks here
 * rather than reading main.mediaServerType itself.
 */

export {
  AUTH_TOKEN,
  DEVICE_ID,
  MEDIA_ID,
  MEDIA_SERVER_KINDS,
  USERNAME,
  USER_ID,
  isJellyfinFamily,
};
export type { JellyfinFamilyKind, MediaServerKind };

/** The kind of account a person signing in with each server gets. */
export const USER_TYPE: Record<MediaServerKind, UserType> = {
  plex: UserType.PLEX,
  jellyfin: UserType.JELLYFIN,
  emby: UserType.EMBY,
};

/** The server a kind of account is for; undefined for a local account. */
export const kindOfUserType = (
  userType: UserType | undefined
): MediaServerKind | undefined =>
  MEDIA_SERVER_KINDS.find((kind) => USER_TYPE[kind] === userType);

/**
 * The primary server: the one chosen at setup (or made primary since). It
 * gives titles their default play link and is listed first. Undefined
 * before setup.
 */
export const primaryServer = (): MediaServerKind | undefined =>
  kindOfType(getSettings().main.mediaServerType);

/** The connected servers, the primary one first, then Plex, Jellyfin, Emby. */
export const connectedServers = (): MediaServerKind[] =>
  connectedKindsOf(getSettings());

/** Seerr is connected to this server. The primary one always is. */
export const isConnected = (kind: MediaServerKind): boolean =>
  connectedServers().includes(kind);

/**
 * The connected Jellyfin or Emby server, the primary one first: what the
 * routes and pages that know one Jellyfin-family server work with.
 */
export const jellyfinFamilyServer = (): JellyfinFamilyKind | undefined =>
  connectedServers().find(isJellyfinFamily);

export const serverName = (kind: MediaServerKind): string =>
  kind === 'plex' ? 'Plex' : kind === 'emby' ? 'Emby' : 'Jellyfin';

/** A Jellyfin or Emby server's settings. */
export const jellyfinFamily = (kind: JellyfinFamilyKind): JellyfinSettings =>
  getSettings()[kind];

interface HostnameParams {
  useSsl?: boolean;
  ip?: string;
  port?: number;
  urlBase?: string;
}

/** The address Seerr reaches a server at, from its settings. */
export const hostnameOf = ({
  useSsl,
  ip,
  port,
  urlBase,
}: HostnameParams): string =>
  `${useSsl ? 'https' : 'http'}://${ip}:${port}${urlBase ?? ''}`;

/** The address Seerr reaches this server at. */
export const hostnameFor = (kind: MediaServerKind): string =>
  hostnameOf(kind === 'plex' ? getSettings().plex : jellyfinFamily(kind));

/**
 * The address people reach a Jellyfin or Emby server at, for links: the
 * external address when one is set.
 */
export const externalHostFor = (kind: JellyfinFamilyKind): string =>
  jellyfinFamily(kind).externalHostname || hostnameFor(kind);

/**
 * People may sign in with their account on this server. The single switch
 * for media server sign-in (main.mediaServerLogin) still turns them all off.
 */
export const signInAllowed = (kind: MediaServerKind): boolean => {
  const settings = getSettings();
  return (
    isConnected(kind) &&
    settings[kind]?.signIn !== false &&
    settings.main.mediaServerLogin !== false
  );
};

/**
 * Makes a server the primary one and connects it, at setup. Its sign-in
 * follows the switch for media server sign-in. The caller saves.
 */
export const connectAsPrimary = (kind: MediaServerKind): void => {
  const settings = getSettings();
  settings.main.mediaServerType = typeOfKind(kind);
  settings[kind].connected = true;
  settings[kind].signIn = settings.main.mediaServerLogin !== false;
};

/** The servers a person has an account linked from. */
export const linkedServers = (
  user: Partial<Pick<User, 'plexId' | 'jellyfinUserId' | 'embyUserId'>>
): MediaServerKind[] =>
  MEDIA_SERVER_KINDS.filter((kind) => !!user[USER_ID[kind]]);

/** A person's account on a Jellyfin or Emby server, as Seerr keeps it. */
export interface JellyfinAccountColumns {
  userId?: string | null;
  username?: string | null;
  deviceId?: string | null;
  authToken?: string | null;
}

/** Reads a person's account on a Jellyfin or Emby server. */
export const jellyfinAccountOf = (
  user: Partial<User>,
  kind: JellyfinFamilyKind
): JellyfinAccountColumns => ({
  userId: user[USER_ID[kind]],
  username: user[USERNAME[kind]],
  deviceId: user[DEVICE_ID[kind]],
  authToken: user[AUTH_TOKEN[kind]],
});

/**
 * The columns that hold a person's account on a Jellyfin or Emby server,
 * to save or update. Only the fields given are included.
 */
export const jellyfinAccountColumns = (
  kind: JellyfinFamilyKind,
  account: JellyfinAccountColumns
): Partial<User> => {
  const columns: Partial<User> = {};
  if (account.userId !== undefined) columns[USER_ID[kind]] = account.userId;
  if (account.username !== undefined) {
    columns[USERNAME[kind]] = account.username;
  }
  if (account.deviceId !== undefined) {
    columns[DEVICE_ID[kind]] = account.deviceId;
  }
  if (account.authToken !== undefined) {
    columns[AUTH_TOKEN[kind]] = account.authToken;
  }
  return columns;
};

/**
 * The account Seerr reads a Jellyfin or Emby server's libraries as: the
 * one chosen for it, else the owner's (user 1's) linked account. Undefined
 * when there is neither.
 */
export const jellyfinAdmin = async (
  kind: JellyfinFamilyKind
): Promise<{ userId: string; deviceId?: string } | undefined> => {
  const owner = await getRepository(User).findOne({
    where: { id: 1 },
    select: ['id', USER_ID[kind], DEVICE_ID[kind]],
  });
  const userId = jellyfinFamily(kind).adminUserId || owner?.[USER_ID[kind]];
  if (!owner && !userId) {
    return undefined;
  }
  return {
    userId: userId ?? '',
    deviceId: owner?.[DEVICE_ID[kind]] ?? undefined,
  };
};

/**
 * A client for a Jellyfin or Emby server with its API key. As the admin
 * account (jellyfinAdmin) when asked, for calls that list a user's
 * libraries or items.
 */
export const jellyfinClient = async (
  kind: JellyfinFamilyKind,
  { asAdmin = false }: { asAdmin?: boolean } = {}
): Promise<JellyfinAPI> => {
  const { apiKey } = jellyfinFamily(kind);
  if (!asAdmin) {
    return new JellyfinAPI(hostnameFor(kind), apiKey, undefined, kind);
  }
  const admin = await jellyfinAdmin(kind);
  const client = new JellyfinAPI(
    hostnameFor(kind),
    apiKey,
    admin?.deviceId,
    kind
  );
  client.setUserId(admin?.userId ?? '');
  return client;
};
