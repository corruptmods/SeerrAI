import LidarrAPI from '@server/api/servarr/lidarr';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

/*
 * Music needs a default Lidarr and can be turned off for everyone
 * (Settings → Features) or per user (middleware/music).
 */

/** Lidarr API client for a server. */
export const lidarrApi = (server: LidarrSettings): LidarrAPI =>
  new LidarrAPI({
    apiKey: server.apiKey,
    url: LidarrAPI.buildUrl(server, '/api/v1'),
  });

/** Lidarr used for music requests unless another is chosen. */
export const defaultLidarr = (): LidarrSettings | undefined =>
  getSettings().lidarr.find((server) => server.isDefault);

/** True when a default Lidarr exists and music isn't off for everyone. */
export const musicReady = (): boolean =>
  getSettings().fullPublicSettings.musicReady;
