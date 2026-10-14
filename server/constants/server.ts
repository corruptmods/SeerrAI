export enum MediaServerType {
  PLEX = 1,
  JELLYFIN,
  EMBY,
  NOT_CONFIGURED,
}

export enum ServerType {
  JELLYFIN = 'Jellyfin',
  EMBY = 'Emby',
}

/**
 * A media server Seerr can be connected to. There is at most one of each,
 * and each keeps its own settings and its own ids on titles and people.
 */
export type MediaServerKind = 'plex' | 'jellyfin' | 'emby';

/** Jellyfin and Emby, which share an API (and Seerr's code for it). */
export type JellyfinFamilyKind = 'jellyfin' | 'emby';

/** Every kind, in the order they are listed after the primary one. */
export const MEDIA_SERVER_KINDS: readonly MediaServerKind[] = [
  'plex',
  'jellyfin',
  'emby',
];

const KIND_OF_TYPE: Partial<Record<MediaServerType, MediaServerKind>> = {
  [MediaServerType.PLEX]: 'plex',
  [MediaServerType.JELLYFIN]: 'jellyfin',
  [MediaServerType.EMBY]: 'emby',
};

const TYPE_OF_KIND: Record<MediaServerKind, MediaServerType> = {
  plex: MediaServerType.PLEX,
  jellyfin: MediaServerType.JELLYFIN,
  emby: MediaServerType.EMBY,
};

/** The kind a MediaServerType stands for; undefined before setup. */
export const kindOfType = (
  type: MediaServerType | number | undefined
): MediaServerKind | undefined =>
  type === undefined ? undefined : KIND_OF_TYPE[type as MediaServerType];

export const typeOfKind = (kind: MediaServerKind): MediaServerType =>
  TYPE_OF_KIND[kind];

export const isJellyfinFamily = (
  kind: MediaServerKind | undefined
): kind is JellyfinFamilyKind => kind === 'jellyfin' || kind === 'emby';

/** Each server's ids on a title: regular, then 4K. */
export const MEDIA_ID = {
  plex: ['ratingKey', 'ratingKey4k'],
  jellyfin: ['jellyfinMediaId', 'jellyfinMediaId4k'],
  emby: ['embyMediaId', 'embyMediaId4k'],
} as const;

/** Each server's account id on a person. */
export const USER_ID = {
  plex: 'plexId',
  jellyfin: 'jellyfinUserId',
  emby: 'embyUserId',
} as const;

/** Each server's account name on a person. */
export const USERNAME = {
  plex: 'plexUsername',
  jellyfin: 'jellyfinUsername',
  emby: 'embyUsername',
} as const;

/** The device Seerr signs in to Jellyfin or Emby as, for a person. */
export const DEVICE_ID = {
  jellyfin: 'jellyfinDeviceId',
  emby: 'embyDeviceId',
} as const;

/** The token Jellyfin or Emby gave a person when they signed in. */
export const AUTH_TOKEN = {
  jellyfin: 'jellyfinAuthToken',
  emby: 'embyAuthToken',
} as const;
