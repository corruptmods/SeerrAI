import QBittorrentAPI from '@server/api/downloadclients/qbittorrent';
import SabnzbdAPI from '@server/api/downloadclients/sabnzbd';
import type { DownloadClient } from '@server/api/downloadclients/types';
import type { DownloadClientSettings } from '@server/lib/settings';

export type { DownloadClient, LiveDownload } from './types';

/** The API for a configured download client, by its type. */
export const downloadClientFor = (
  settings: DownloadClientSettings
): DownloadClient =>
  settings.type === 'qbittorrent'
    ? new QBittorrentAPI(settings)
    : new SabnzbdAPI(settings);
