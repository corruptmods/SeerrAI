import DelugeAPI from '@server/api/downloadclients/deluge';
import NzbgetAPI from '@server/api/downloadclients/nzbget';
import QBittorrentAPI from '@server/api/downloadclients/qbittorrent';
import RtorrentAPI from '@server/api/downloadclients/rtorrent';
import SabnzbdAPI from '@server/api/downloadclients/sabnzbd';
import TransmissionAPI from '@server/api/downloadclients/transmission';
import type { DownloadClient } from '@server/api/downloadclients/types';
import type { DownloadClientSettings } from '@server/lib/settings';

export type { DownloadClient, LiveDownload } from './types';

/** The API for a configured download client, by its type. */
export const downloadClientFor = (
  settings: DownloadClientSettings
): DownloadClient => {
  switch (settings.type) {
    case 'qbittorrent':
      return new QBittorrentAPI(settings);
    case 'transmission':
      return new TransmissionAPI(settings);
    case 'deluge':
      return new DelugeAPI(settings);
    case 'rtorrent':
      return new RtorrentAPI(settings);
    case 'nzbget':
      return new NzbgetAPI(settings);
    default:
      return new SabnzbdAPI(settings);
  }
};
