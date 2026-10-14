import type { MediaServerKind } from '@server/constants/server';

/** The media servers' names as people know them. */
export const SERVER_NAMES: Record<MediaServerKind, string> = {
  plex: 'Plex',
  jellyfin: 'Jellyfin',
  emby: 'Emby',
};
