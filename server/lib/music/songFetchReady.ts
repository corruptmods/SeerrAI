import { isTorrentClient } from '@server/api/downloadclients';
import type { DownloadClientSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

/*
 * Whether songs on no single can be taken from their albums: Settings →
 * Music allows it, and Backfill, whose Prowlarr and download client do the
 * fetching (lib/music/songFetch), is on and set up.
 */

/** Whether songs can be taken from albums here, and why not. */
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

/** Backfill's client for a kind of release. */
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
