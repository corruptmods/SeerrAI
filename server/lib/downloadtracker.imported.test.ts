import { MediaType } from '@server/constants/media';
import downloadTracker, {
  IMPORTED_HOLD_MS,
  IMPORTED_SCAN_DELAY_MS,
  IMPORTED_SCAN_TRIES,
  leftImported,
} from '@server/lib/downloadtracker';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import axios from 'axios';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Between Sonarr importing an episode and the media server listing it, the
 * title is in no queue. A download that leaves the queue imported shows as
 * being added to the library until the media server's scan (a minute after
 * the import) lists it.
 */

let queue: Record<string, unknown>[] = [];
/** Sonarr's history of imports, as /history/since answers. */
let history: Record<string, unknown>[] = [];

const record = (
  id: string,
  episode: number,
  status: string,
  trackedDownloadState: string,
  sizeleft: number
) => ({
  seriesId: 1286,
  episodeId: 145875 + episode,
  episode: {
    id: 145875 + episode,
    seasonNumber: 1,
    episodeNumber: episode,
    absoluteEpisodeNumber: 0,
  },
  title: `Wrenna.S01E0${episode}.1080p.HEVC.x265-LeSigh`,
  size: 500,
  sizeleft,
  timeleft: '00:00:00',
  status,
  trackedDownloadStatus: 'ok',
  trackedDownloadState,
  downloadId: id,
  protocol: 'usenet',
});

beforeEach(async () => {
  await downloadTracker.resetDownloadTracker();
  queue = [];
  history = [];
  const settings = getSettings();
  settings.downloadClients = [];
  settings.radarr = [];
  settings.sonarr = [
    {
      id: 0,
      name: 'Sonarr',
      hostname: 'sonarr',
      port: 8989,
      apiKey: 'x',
      useSsl: false,
      is4k: false,
      isDefault: true,
      syncEnabled: true,
    } as unknown as SonarrSettings,
  ];
  const fake = {
    interceptors: {
      request: { use: () => 0 },
      response: { use: () => 0 },
    },
    get: async (url: string) =>
      url === '/history/since'
        ? { data: history }
        : { data: { records: queue, totalRecords: queue.length } },
    post: async () => ({ data: {} }),
  };
  mock.method(axios, 'create', () => fake);
});

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  downloadTracker.whenImported(() => undefined);
});

describe('a download Sonarr imported', () => {
  it('is shown as being added until the media server lists it', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
    let scans = 0;
    downloadTracker.whenImported(() => {
      scans++;
    });
    queue = [
      record('one', 1, 'completed', 'importing', 0),
      record('two', 2, 'downloading', 'downloading', 400),
    ];
    await downloadTracker.updateDownloads();
    assert.deepEqual(
      downloadTracker.getSeriesProgress(0, 1286).map((i) => i.stage),
      ['importing', 'downloading']
    );

    // Episode 1 imported and left the queue; episode 2 still downloading.
    queue = [record('two', 2, 'downloading', 'downloading', 400)];
    mock.timers.tick(15_000);
    await downloadTracker.updateDownloads();
    const now = downloadTracker.getSeriesProgress(0, 1286);
    assert.deepEqual(
      now.map((i) => [i.episode?.episodeNumber, i.stage, i.sizeLeft]),
      [
        [2, 'downloading', 400],
        [1, 'imported', 0],
      ]
    );

    // The media server's recent scan runs a minute after the import.
    assert.equal(scans, 0);
    mock.timers.tick(IMPORTED_SCAN_DELAY_MS);
    assert.equal(scans, 1);

    // Its scan lists the series: the import is no longer shown.
    downloadTracker.forgetImported('series', 0, 1286);
    assert.deepEqual(
      downloadTracker.getSeriesProgress(0, 1286).map((i) => i.stage),
      ['downloading']
    );
  });

  it('scans again each minute, a few times, until the media server lists it', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_500_000 });
    let scans = 0;
    downloadTracker.whenImported(async () => {
      scans++;
    });
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    queue = [record('one', 1, 'completed', 'importing', 0)];
    await downloadTracker.updateDownloads();
    queue = [];
    await downloadTracker.updateDownloads();

    // Plex hasn't listed it on the first two scans.
    for (let i = 1; i <= 2; i++) {
      mock.timers.tick(IMPORTED_SCAN_DELAY_MS);
      await settle();
      assert.equal(scans, i);
    }
    // The third lists it: no more scans.
    mock.timers.tick(IMPORTED_SCAN_DELAY_MS);
    downloadTracker.forgetImported('series', 0, 1286);
    await settle();
    assert.equal(scans, 3);
    mock.timers.tick(IMPORTED_SCAN_DELAY_MS * 3);
    await settle();
    assert.equal(scans, 3);
  });

  it('leaves it to the regular scan after a few tries', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000 });
    let scans = 0;
    downloadTracker.whenImported(async () => {
      scans++;
    });
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    queue = [record('one', 1, 'completed', 'importing', 0)];
    await downloadTracker.updateDownloads();
    queue = [];
    await downloadTracker.updateDownloads();
    for (let i = 0; i < IMPORTED_SCAN_TRIES + 2; i++) {
      mock.timers.tick(IMPORTED_SCAN_DELAY_MS);
      await settle();
    }
    assert.equal(scans, IMPORTED_SCAN_TRIES);
    // Still shown as being added.
    assert.equal(downloadTracker.getSeriesProgress(0, 1286).length, 1);
  });

  it('stops being shown after a while if the media server never lists it', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 2_000_000 });
    queue = [record('one', 1, 'completed', 'importPending', 0)];
    await downloadTracker.updateDownloads();
    queue = [];
    await downloadTracker.updateDownloads();
    assert.equal(downloadTracker.getSeriesProgress(0, 1286).length, 1);
    mock.timers.tick(IMPORTED_HOLD_MS + 1);
    assert.equal(downloadTracker.getSeriesProgress(0, 1286).length, 0);
  });

  it('keeps an import made after the scan began until the next scan', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 3_000_000 });
    const scanBegan = Date.now();
    mock.timers.tick(5_000);
    queue = [record('one', 1, 'completed', 'importing', 0)];
    await downloadTracker.updateDownloads();
    queue = [];
    await downloadTracker.updateDownloads();
    downloadTracker.forgetImported('series', 0, 1286, scanBegan);
    assert.equal(downloadTracker.getSeriesProgress(0, 1286).length, 1);
  });

  it('is not shown when the download was removed or failed instead', async () => {
    queue = [
      record('removed', 1, 'downloading', 'downloading', 300),
      record('failed', 2, 'failed', 'failedPending', 300),
    ];
    await downloadTracker.updateDownloads();
    queue = [];
    await downloadTracker.updateDownloads();
    assert.deepEqual(downloadTracker.getSeriesProgress(0, 1286), []);
  });
});

describe('a download imported between two reads of the queue', () => {
  /** Sonarr's record of importing an episode, as its history has it. */
  const imported = (
    id: number,
    downloadId: string | undefined,
    episode = 1
  ) => ({
    id,
    date: new Date().toISOString(),
    downloadId,
    sourceTitle: `Wrenna.S01E0${episode}.1080p.HEVC.x265-LeSigh`,
    seriesId: 1286,
    episode: {
      id: 145875 + episode,
      seasonNumber: 1,
      episodeNumber: episode,
    },
    data: { size: '500' },
  });

  it('is shown as being added all the same, from Sonarr’s history', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 4_000_000 });
    let scans = 0;
    downloadTracker.whenImported(() => {
      scans++;
    });
    // Last seen still downloading; grabbed, finished and imported since.
    queue = [record('one', 1, 'downloading', 'downloading', 400)];
    await downloadTracker.updateDownloads();
    queue = [];
    history = [imported(10, 'one')];
    mock.timers.tick(30_000);
    await downloadTracker.updateDownloads();
    assert.deepEqual(
      downloadTracker
        .getSeriesProgress(0, 1286)
        .map((i) => [i.episode?.episodeNumber, i.stage, i.sizeLeft]),
      [[1, 'imported', 0]]
    );
    mock.timers.tick(IMPORTED_SCAN_DELAY_MS);
    assert.equal(scans, 1, 'the media server’s scan runs a minute later');
  });

  it('is held once, and not again after the media server lists it', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 5_000_000 });
    await downloadTracker.updateDownloads();
    history = [imported(10, 'one')];
    mock.timers.tick(30_000);
    await downloadTracker.updateDownloads();
    assert.equal(downloadTracker.getSeriesProgress(0, 1286).length, 1);

    mock.timers.tick(30_000);
    downloadTracker.forgetImported('series', 0, 1286);
    // Read again: history is read from slightly before the last look.
    await downloadTracker.updateDownloads();
    assert.deepEqual(downloadTracker.getSeriesProgress(0, 1286), []);
  });

  it('leaves out what is still in the queue, and what was imported by hand', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 6_000_000 });
    await downloadTracker.updateDownloads();
    // Episode 2 of a pack is in, the rest of it still importing.
    queue = [record('pack', 1, 'completed', 'importing', 0)];
    history = [imported(11, 'pack', 2), imported(12, undefined, 3)];
    mock.timers.tick(30_000);
    await downloadTracker.updateDownloads();
    assert.deepEqual(
      downloadTracker
        .getSeriesProgress(0, 1286)
        .map((i) => [i.episode?.episodeNumber, i.stage]),
      [
        [1, 'importing'],
        [2, 'imported'],
      ]
    );
  });

  it('only starts from the first look, so a restart shows nothing old', async () => {
    history = [imported(10, 'one')];
    await downloadTracker.updateDownloads();
    assert.deepEqual(downloadTracker.getSeriesProgress(0, 1286), []);
  });
});

describe('what counts as imported when it leaves the queue', () => {
  const item = (
    stage: Parameters<typeof leftImported>[0]['stage'],
    sizeLeft: number
  ) => ({
    mediaType: MediaType.TV,
    externalId: 1,
    size: 500,
    sizeLeft,
    status: '',
    stage,
    timeLeft: '',
    title: 'x',
    downloadId: 'x',
  });

  it('being imported, readied for import, or with nothing left', () => {
    assert.equal(leftImported(item('importing', 0)), true);
    assert.equal(leftImported(item('finishing', 0)), true);
    assert.equal(leftImported(item('downloading', 0)), true);
    assert.equal(leftImported(item('downloading', 200)), false);
    assert.equal(leftImported(item('failed', 0)), false);
    assert.equal(leftImported(item('needsAttention', 0)), false);
    assert.equal(leftImported(item('queued', 500)), false);
  });
});
