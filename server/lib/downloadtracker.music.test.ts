import { MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import downloadTracker from '@server/lib/downloadtracker';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import axios from 'axios';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Music downloads: Lidarr's queue, read like Radarr's and Sonarr's, each
 * item naming the album it is for, so an artist's page, an album's page and
 * a request card can each show their own.
 */

let queue: Record<string, unknown>[] = [];
let asked: string[] = [];

const record = (
  id: string,
  album: { id: number; title: string; foreignAlbumId: string },
  status: string,
  trackedDownloadState: string,
  sizeleft: number
) => ({
  artistId: 7,
  albumId: album.id,
  album,
  artist: { id: 7, artistName: 'Glasswing', foreignArtistId: 'artist' },
  title: `Glasswing - ${album.title} (FLAC)`,
  size: 500,
  sizeleft,
  timeleft: '00:01:00',
  status,
  trackedDownloadStatus: 'ok',
  trackedDownloadState,
  downloadId: id,
  protocol: 'torrent',
});

const SING = { id: 70, title: 'Sing to the Ferryman', foreignAlbumId: 'sing' };
const FOG_B = { id: 71, title: 'Fog B', foreignAlbumId: 'kid-a' };

const LIDARR = {
  id: 0,
  name: 'Lidarr',
  hostname: 'lidarr',
  port: 8686,
  apiKey: 'x',
  useSsl: false,
  baseUrl: '',
  is4k: false,
  isDefault: true,
  // The queue is read whether or not Lidarr's library is scanned.
  syncEnabled: false,
  activeProfileId: 1,
  activeDirectory: '/music',
  activeMetadataProfileId: 1,
  tags: [],
} as unknown as LidarrSettings;

beforeEach(async () => {
  await downloadTracker.resetDownloadTracker();
  queue = [];
  asked = [];
  const settings = getSettings();
  settings.downloadClients = [];
  settings.radarr = [];
  settings.sonarr = [];
  settings.lidarr = [LIDARR];
  settings.main.disabledFeatures = [];
  const fake = {
    interceptors: {
      request: { use: () => 0 },
      response: { use: () => 0 },
    },
    get: async (url: string) => {
      asked.push(url);
      return { data: { records: queue, totalRecords: queue.length } };
    },
    post: async () => ({ data: {} }),
  };
  mock.method(axios, 'create', () => fake);
});

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  downloadTracker.whenImported(() => undefined);
  const settings = getSettings();
  settings.lidarr = [];
  settings.main.disabledFeatures = [];
});

describe('Lidarr’s downloads', () => {
  it('are kept by artist, each saying its album', async () => {
    queue = [
      record('sing', SING, 'downloading', 'downloading', 250),
      record('kid-a', FOG_B, 'queued', 'downloading', 500),
    ];

    await downloadTracker.updateDownloads();

    const all = downloadTracker.getMusicProgress(0, 7);
    assert.deepEqual(
      all.map((item) => [item.mediaType, item.album?.title, item.stage]),
      [
        [MediaType.MUSIC, 'Sing to the Ferryman', 'downloading'],
        [MediaType.MUSIC, 'Fog B', 'queued'],
      ]
    );
    assert.deepEqual(
      downloadTracker.getMusicProgress(0, 7, 71).map((i) => i.downloadId),
      ['kid-a']
    );
    assert.deepEqual(downloadTracker.getMusicProgress(0, 8), []);
  });

  it('show on the artist’s own record', async () => {
    queue = [record('sing', SING, 'downloading', 'downloading', 250)];
    await downloadTracker.updateDownloads();

    const artist = new Media({
      mediaType: MediaType.MUSIC,
      tmdbId: 0,
      serviceId: 0,
      externalServiceId: 7,
    });
    artist.getDownloadingItem();

    assert.deepEqual(
      artist.downloadStatus?.map((item) => item.album?.id),
      [70]
    );
  });

  it('are shown as being added once imported, until the album is here', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
    let scans = 0;
    downloadTracker.whenImported(() => {
      scans++;
    });
    queue = [record('sing', SING, 'completed', 'importing', 0)];
    await downloadTracker.updateDownloads();

    queue = [];
    mock.timers.tick(15_000);
    await downloadTracker.updateDownloads();
    assert.deepEqual(
      downloadTracker.getMusicProgress(0, 7).map((i) => [i.album?.id, i.stage]),
      [[70, 'imported']]
    );
    assert.deepEqual(downloadTracker.heldMusicImports(), [
      { serverId: 0, albumId: 70 },
    ]);

    // The music scan runs a minute after the import.
    mock.timers.tick(60_000);
    assert.equal(scans, 1);

    downloadTracker.forgetImportedAlbum(0, 70);
    assert.deepEqual(downloadTracker.getMusicProgress(0, 7), []);
  });

  it('are not read while music is off', async () => {
    getSettings().main.disabledFeatures = ['music'];
    queue = [record('sing', SING, 'downloading', 'downloading', 250)];

    await downloadTracker.updateDownloads();

    assert.deepEqual(asked, []);
    assert.deepEqual(downloadTracker.getMusicProgress(0, 7), []);
  });
});
