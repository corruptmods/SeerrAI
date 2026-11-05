import { isTorrentClient } from '@server/api/downloadclients';
import type { DownloadClientSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

/*
 * Songs with no single are taken from albums via Backfill's Prowlarr and
 * download client (lib/music/songFetch).
 */

/** Why songs can't be taken from albums, or undefined when they can. */
export const songFetchProblem = (): string | undefined => {
  const settings = getSettings();
  const backfillSettings = settings.backfill;
  if (!settings.music.songsFromAlbums)
    return 'Taking songs from albums is off.';
  if (!backfillSettings.enabled) return 'Backfill is turned off.';
  if (
    !backfillSettings.prowlarr.hostname ||
    !backfillSettings.prowlarr.apiKey
  ) {
    return 'Prowlarr is not set up in Settings → Services.';
  }
  if (!clientFor('torrent') && !clientFor('usenet')) {
    return 'No download client is chosen in Settings → Backfill.';
  }
  return undefined;
};

/** Backfill's download client for a protocol. */
export const clientFor = (
  protocol: 'torrent' | 'usenet'
): DownloadClientSettings | undefined => {
  const settings = getSettings();
  const id =
    protocol === 'torrent'
      ? settings.backfill.torrentClientId
      : settings.backfill.usenetClientId;
  return settings.downloadClients.find(
    (c) => c.id === id && isTorrentClient(c.type) === (protocol === 'torrent')
  );
};
