import DelugeAPI from '@server/api/downloadclients/deluge';
import NzbgetAPI from '@server/api/downloadclients/nzbget';
import QBittorrentAPI from '@server/api/downloadclients/qbittorrent';
import RtorrentAPI from '@server/api/downloadclients/rtorrent';
import SabnzbdAPI from '@server/api/downloadclients/sabnzbd';
import TransmissionAPI from '@server/api/downloadclients/transmission';
import type {
  TorrentClient,
  UsenetClient,
} from '@server/api/downloadclients/types';
import type {
  DownloadClientSettings,
  DownloadClientType,
} from '@server/lib/settings';

export type {
  ClientTorrent,
  ClientTorrentFile,
  DownloadClient,
  LiveDownload,
  TorrentClient,
  TorrentState,
  UsenetClient,
  UsenetJob,
} from './types';

export const TORRENT_CLIENT_TYPES: DownloadClientType[] = [
  'qbittorrent',
  'transmission',
  'deluge',
  'rtorrent',
];
export const isTorrentClient = (type: DownloadClientType): boolean =>
  TORRENT_CLIENT_TYPES.includes(type);

/** Product name per client type. */
export const CLIENT_PRODUCTS: Record<DownloadClientType, string> = {
  sabnzbd: 'SABnzbd',
  nzbget: 'NZBGet',
  qbittorrent: 'qBittorrent',
  transmission: 'Transmission',
  deluge: 'Deluge',
  rtorrent: 'rTorrent',
};

/** Backfill's API for a configured torrent client. */
export const torrentClientFor = (
  settings: DownloadClientSettings
): TorrentClient => {
  switch (settings.type) {
    case 'qbittorrent':
      return new QBittorrentAPI(settings);
    case 'transmission':
      return new TransmissionAPI(settings);
    case 'deluge':
      return new DelugeAPI(settings);
    case 'rtorrent':
      return new RtorrentAPI(settings);
    default:
      throw new Error(`${settings.name} is not a torrent client.`);
  }
};

/** Backfill's API for a configured Usenet client. */
export const usenetClientFor = (
  settings: DownloadClientSettings
): UsenetClient => {
  switch (settings.type) {
    case 'sabnzbd':
      return new SabnzbdAPI(settings);
    case 'nzbget':
      return new NzbgetAPI(settings);
    default:
      throw new Error(`${settings.name} is not a Usenet client.`);
  }
};

/** The API for a configured download client. */
export const downloadClientFor = (
  settings: DownloadClientSettings
): TorrentClient | UsenetClient =>
  isTorrentClient(settings.type)
    ? torrentClientFor(settings)
    : usenetClientFor(settings);
