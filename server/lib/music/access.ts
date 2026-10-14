import LidarrAPI from '@server/api/servarr/lidarr';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

/*
 * Lidarr, which music goes through, and whether music is there at all:
 * once an admin has added a default Lidarr, unless music is turned off for
 * everyone (Settings → Features). Each person can also turn it off for
 * themselves (see middleware/music).
 */

/** A client for one Lidarr server. */
export const lidarrApi = (server: LidarrSettings): LidarrAPI =>
  new LidarrAPI({
    apiKey: server.apiKey,
    url: LidarrAPI.buildUrl(server, '/api/v1'),
  });

/** The Lidarr music is requested through, unless another is chosen. */
export const defaultLidarr = (): LidarrSettings | undefined =>
  getSettings().lidarr.find((server) => server.isDefault);

/** A default Lidarr is set up and music is not turned off for everyone. */
export const musicReady = (): boolean =>
  getSettings().fullPublicSettings.musicReady;
