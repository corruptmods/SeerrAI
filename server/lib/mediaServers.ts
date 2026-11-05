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
  MUSIC_ALBUM_ID,
  USERNAME,
  USER_ID,
  isJellyfinFamily,
  kindOfType,
  typeOfKind,
} from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import type { PlayLink } from '@server/entity/Media';
import type MusicAlbum from '@server/entity/MusicAlbum';
import { User } from '@server/entity/User';
import type { JellyfinSettings } from '@server/lib/settings';
import { connectedKindsOf, getSettings } from '@server/lib/settings';

/*
 * Which media servers Seerr is connected to, and where each keeps its
 * settings and ids. Ask here instead of reading main.mediaServerType.
 */

export {
  AUTH_TOKEN,
  DEVICE_ID,
  MEDIA_ID,
  MEDIA_SERVER_KINDS,
  MUSIC_ALBUM_ID,
  USERNAME,
  USER_ID,
  isJellyfinFamily,
};
export type { JellyfinFamilyKind, MediaServerKind };

/** The account type a user signing in with each server gets. */
export const USER_TYPE: Record<MediaServerKind, UserType> = {
  plex: UserType.PLEX,
  jellyfin: UserType.JELLYFIN,
  emby: UserType.EMBY,
};

/** The server an account type belongs to; undefined for local accounts. */
export const kindOfUserType = (
  userType: UserType | undefined
): MediaServerKind | undefined =>
  MEDIA_SERVER_KINDS.find((kind) => USER_TYPE[kind] === userType);

/**
 * The server chosen at setup (or made primary since). It supplies titles'
 * default play link and is listed first. Undefined before setup.
 */
export const primaryServer = (): MediaServerKind | undefined =>
  kindOfType(getSettings().main.mediaServerType);

/** Connected servers: primary first, then Plex, Jellyfin, Emby. */
export const connectedServers = (): MediaServerKind[] =>
  connectedKindsOf(getSettings());

/** Whether Seerr is connected to this server; the primary always is. */
export const isConnected = (kind: MediaServerKind): boolean =>
  connectedServers().includes(kind);

/**
 * The connected Jellyfin or Emby server, primary first, for routes and pages
 * that handle a single Jellyfin-family server.
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
 * The user-facing Jellyfin or Emby address for links: the external one when
 * set.
 */
export const externalHostFor = (kind: JellyfinFamilyKind): string =>
  jellyfinFamily(kind).externalHostname || hostnameFor(kind);

/**
 * Links to open one item: its page in the server's web app, plus the iOS app
 * for Plex.
 */
export const serverItemLinks = (
  kind: MediaServerKind,
  itemId: string
): { url: string; iosUrl?: string } => {
  if (kind === 'plex') {
    const { machineId, webAppUrl } = getSettings().plex;
    return {
      url: `${
        webAppUrl ? webAppUrl : 'https://app.plex.tv/desktop'
      }#!/server/${machineId}/details?key=%2Flibrary%2Fmetadata%2F${itemId}`,
      iosUrl: `plex://preplay/?metadataKey=%2Flibrary%2Fmetadata%2F${itemId}&server=${machineId}`,
    };
  }
  // Jellyfin and Emby name their item page differently.
  const pageName = kind === 'emby' ? 'item' : 'details';
  const { serverId } = jellyfinFamily(kind);
  return {
    url: `${externalHostFor(kind)}/web/index.html#!/${pageName}?id=${itemId}&context=home&serverId=${serverId}`,
  };
};

/**
 * Play links for an album, one per connected server that has it, primary
 * first. An album is stored once per artist it is under, so every row's ids
 * count.
 */
export const albumPlayLinks = (
  albums: Pick<MusicAlbum, 'ratingKey' | 'jellyfinItemId' | 'embyItemId'>[]
): PlayLink[] =>
  connectedServers().flatMap((kind) => {
    const column = MUSIC_ALBUM_ID[kind];
    const itemId = albums.find((album) => album[column])?.[column];
    if (!itemId) return [];
    const { url, iosUrl } = serverItemLinks(kind, itemId);
    return [
      {
        server: kind,
        name: serverName(kind),
        url,
        ...(iosUrl ? { iosUrl } : {}),
      },
    ];
  });

/**
 * Whether users may sign in with this server: connected and its own switch
 * (Settings → Media Servers) on. The legacy main.mediaServerLogin only
 * mirrors these (lib/mediaServerAdmin).
 */
export const signInAllowed = (kind: MediaServerKind): boolean =>
  isConnected(kind) && getSettings()[kind]?.signIn !== false;

/**
 * At setup, makes a server primary and connects it; its sign-in follows the
 * media server sign-in switch. For Jellyfin and Emby, `adminUserId` is the
 * setup admin account, used to read libraries from then on (jellyfinAdmin).
 * The caller saves.
 */
export const connectAsPrimary = (
  kind: MediaServerKind,
  adminUserId?: string
): void => {
  const settings = getSettings();
  settings.main.mediaServerType = typeOfKind(kind);
  settings[kind].connected = true;
  settings[kind].signIn = settings.main.mediaServerLogin !== false;
  if (isJellyfinFamily(kind) && adminUserId) {
    settings[kind].adminUserId = adminUserId;
  }
};

/** Servers a user has a linked account from. */
export const linkedServers = (
  user: Partial<Pick<User, 'plexId' | 'jellyfinUserId' | 'embyUserId'>>
): MediaServerKind[] =>
  MEDIA_SERVER_KINDS.filter((kind) => !!user[USER_ID[kind]]);

/** A user's Jellyfin or Emby account as Seerr stores it. */
export interface JellyfinAccountColumns {
  userId?: string | null;
  username?: string | null;
  deviceId?: string | null;
  authToken?: string | null;
}

/** Reads a user's Jellyfin or Emby account. */
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
 * The columns holding a user's Jellyfin or Emby account, for save or update.
 * Only given fields are included.
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
 * The account Seerr reads a Jellyfin or Emby server's libraries as: the one
 * chosen for it, else the owner's (user 1) linked account. Undefined if
 * neither.
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
 * Servers set up before the library account was stored with them relied on
 * the owner's linked account and broke when the owner unlinked it. Stores the
 * owner's account on each connected Jellyfin or Emby server lacking one. Runs
 * at startup; saves only on change.
 */
export const rememberJellyfinAdmins = async (): Promise<void> => {
  const settings = getSettings();
  const missing = connectedServers()
    .filter(isJellyfinFamily)
    .filter((kind) => !settings[kind].adminUserId);
  if (!missing.length) {
    return;
  }
  const owner = await getRepository(User).findOne({
    where: { id: 1 },
    select: ['id', ...missing.map((kind) => USER_ID[kind])],
  });
  let changed = false;
  for (const kind of missing) {
    const userId = owner?.[USER_ID[kind]];
    if (userId) {
      settings[kind].adminUserId = userId;
      changed = true;
    }
  }
  if (changed) {
    await settings.save();
  }
};

/**
 * A Jellyfin or Emby client with the server's API key; optionally as the admin
 * account (jellyfinAdmin), for calls that list a user's libraries or items.
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
