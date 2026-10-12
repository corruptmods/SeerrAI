import { MediaServerType } from '@server/constants/server';
import { getSettings } from '@server/lib/settings';
import { JellyfinWatchSource } from '@server/lib/watchHistory/jellyfin';
import { TautulliWatchSource } from '@server/lib/watchHistory/tautulli';
import type { WatchSource } from '@server/lib/watchHistory/types';

export {
  COMPLETE_PERCENT,
  isCompletedPlay,
} from '@server/lib/watchHistory/types';
export type { Play, WatchSource } from '@server/lib/watchHistory/types';

/**
 * Where watch history comes from on this server: Tautulli for Plex, the
 * server itself for Jellyfin and Emby. Undefined when there is none, so
 * features that need it show nothing rather than guess.
 */
export const watchSource = (): WatchSource | undefined => {
  const settings = getSettings();
  const type = settings.main.mediaServerType;
  if (type === MediaServerType.JELLYFIN || type === MediaServerType.EMBY) {
    const { ip, apiKey } = settings.jellyfin;
    return ip && apiKey
      ? new JellyfinWatchSource(
          type === MediaServerType.EMBY ? 'emby' : 'jellyfin',
          apiKey
        )
      : undefined;
  }
  // Plex, through Tautulli (only ever set up alongside Plex).
  const { hostname, apiKey } = settings.tautulli;
  return hostname && apiKey
    ? new TautulliWatchSource(settings.tautulli)
    : undefined;
};
