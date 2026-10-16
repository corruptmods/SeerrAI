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
 * settings and its ids. Code that works with a media server asks here
 * rather than reading main.mediaServerType itself.
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
 * Where people open one item on a server: its page in the server's web
 * app, and for Plex the iPhone and iPad app too.
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
 * Where to play an album: one link for each connected server that has it,
 * the primary server first. An album is kept once per artist it is under;
 * every row's ids count.
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
 * People may sign in with their account on this server: it is connected
 * and its own switch (Settings → Media Servers) is on. The old single
 * switch, main.mediaServerLogin, only follows these (lib/mediaServerAdmin).
 */
export const signInAllowed = (kind: MediaServerKind): boolean =>
  isConnected(kind) && getSettings()[kind]?.signIn !== false;

/**
 * Makes a server the primary one and connects it, at setup. Its sign-in
 * follows the switch for media server sign-in. For Jellyfin and Emby,
 * `adminUserId` is the administrator account set up with, which Seerr reads
 * the libraries as from then on (jellyfinAdmin). The caller saves.
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
 * Servers set up before the account Seerr reads them as was kept with
 * them relied on the owner's linked account, and stopped working once the
 * owner unlinked it. Each connected Jellyfin or Emby server without one
 * keeps the owner's account from now on. Run at startup; saves when it
 * changes anything.
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
