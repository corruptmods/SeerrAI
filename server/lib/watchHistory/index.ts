import type { MediaServerKind } from '@server/constants/server';
import { connectedServers, jellyfinFamily } from '@server/lib/mediaServers';
import { getSettings } from '@server/lib/settings';
import { CompositeWatchSource } from '@server/lib/watchHistory/composite';
import { JellyfinWatchSource } from '@server/lib/watchHistory/jellyfin';
import { TautulliWatchSource } from '@server/lib/watchHistory/tautulli';
import type { WatchSource } from '@server/lib/watchHistory/types';

export {
  COMPLETE_PERCENT,
  isCompletedPlay,
} from '@server/lib/watchHistory/types';
export type { Play, WatchSource } from '@server/lib/watchHistory/types';

/**
 * Tautulli for Plex (if configured); the server itself for Jellyfin and Emby.
 */
const serverWatchSource = (
  server: MediaServerKind
): WatchSource | undefined => {
  if (server === 'plex') {
    const { tautulli } = getSettings();
    return tautulli.hostname && tautulli.apiKey
      ? new TautulliWatchSource(tautulli)
      : undefined;
  }
  const { ip, apiKey } = jellyfinFamily(server);
  return ip && apiKey ? new JellyfinWatchSource(server, apiKey) : undefined;
};

/**
 * The watch history source for all connected servers, merged when several.
 * Undefined when none, so dependent features show nothing rather than guess.
 */
export const watchSource = (): WatchSource | undefined => {
  const sources = connectedServers().flatMap((server) => {
    const source = serverWatchSource(server);
    return source ? [{ server, source }] : [];
  });
  if (sources.length > 1) {
    return new CompositeWatchSource(sources);
  }
  return sources[0]?.source;
};
