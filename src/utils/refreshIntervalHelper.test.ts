import { MediaStatus, MediaType } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getRequestDownloadStatus,
  refreshIntervalHelper,
  watchMedia,
} from './refreshIntervalHelper';

const createDownloadItem = (
  overrides: Partial<DownloadingItem> & Pick<DownloadingItem, 'downloadId'>
): DownloadingItem => ({
  mediaType: MediaType.TV,
  externalId: 1,
  size: 1000,
  sizeLeft: 500,
  status: 'downloading',
  stage: 'downloading',
  timeLeft: '00:05:00',
  estimatedCompletionTime: new Date('2026-01-01T00:00:00Z'),
  title: 'Test Show',
  ...overrides,
});

const getRequestStatus = (
  downloadStatus: DownloadingItem[] | undefined,
  seasonNumbers: number[]
) => {
  const downloadItem = getRequestDownloadStatus(downloadStatus, seasonNumbers);

  return {
    downloadItem,
    inProgress: downloadItem.length > 0,
  };
};

describe('getRequestDownloadStatus', () => {
  it('returns an empty array when downloadStatus is undefined', () => {
    const status = getRequestStatus(undefined, [1]);

    assert.deepEqual(status.downloadItem, []);
    assert.equal(status.inProgress, false);
  });

  it('returns all items when seasonNumbers is empty', () => {
    const movieDownload = createDownloadItem({
      downloadId: 'movie-1',
      mediaType: MediaType.MOVIE,
    });
    const tvDownload = createDownloadItem({
      downloadId: 'tv-1',
      episode: {
        id: 1,
        seasonNumber: 2,
        episodeNumber: 3,
        absoluteEpisodeNumber: 3,
      },
    });
    const downloads = [movieDownload, tvDownload];

    const status = getRequestStatus(downloads, []);

    assert.deepEqual(status.downloadItem, downloads);
    assert.equal(status.inProgress, true);
  });

  it('returns only items whose episode season matches the request seasons', () => {
    const seasonOne = createDownloadItem({
      downloadId: 's1',
      episode: {
        id: 1,
        seasonNumber: 1,
        episodeNumber: 1,
        absoluteEpisodeNumber: 1,
      },
    });
    const seasonThree = createDownloadItem({
      downloadId: 's3',
      episode: {
        id: 3,
        seasonNumber: 3,
        episodeNumber: 1,
        absoluteEpisodeNumber: 10,
      },
    });
    const downloads = [seasonOne, seasonThree];

    const status = getRequestStatus(downloads, [3]);

    assert.deepEqual(status.downloadItem, [seasonThree]);
    assert.equal(status.inProgress, true);
  });

  it('returns an empty array when no items match the request seasons', () => {
    const seasonThree = createDownloadItem({
      downloadId: 's3',
      episode: {
        id: 3,
        seasonNumber: 3,
        episodeNumber: 1,
        absoluteEpisodeNumber: 10,
      },
    });

    const status = getRequestStatus([seasonThree], [1, 2]);

    assert.deepEqual(status.downloadItem, []);
    assert.equal(status.inProgress, false);
  });

  it('keeps an item Sonarr could not place in a season', () => {
    /*
     * Upstream excluded these. The queue is already narrowed to this series
     * by externalId, so an entry with no episode data is a season pack for
     * the series in question — dropping it meant a pack downloaded with no
     * progress bar and the card stuck on its pre-download status.
     */
    const seasonPack = createDownloadItem({
      downloadId: 'season-pack',
    });
    const seasonTwo = createDownloadItem({
      downloadId: 's2',
      episode: {
        id: 2,
        seasonNumber: 2,
        episodeNumber: 4,
        absoluteEpisodeNumber: 4,
      },
    });

    const status = getRequestStatus([seasonPack, seasonTwo], [2]);

    assert.deepEqual(status.downloadItem, [seasonPack, seasonTwo]);
    assert.equal(status.inProgress, true);
  });

  it('still drops an episode from a season nobody requested', () => {
    const seasonFive = createDownloadItem({
      downloadId: 's5',
      episode: {
        id: 5,
        seasonNumber: 5,
        episodeNumber: 1,
        absoluteEpisodeNumber: 1,
      },
    });

    const status = getRequestStatus([seasonFive], [1, 2]);

    assert.deepEqual(status.downloadItem, []);
    assert.equal(status.inProgress, false);
  });
});

describe('refreshIntervalHelper', () => {
  type Page = { downloadStatus?: DownloadingItem[]; waiting?: boolean };
  const downloading: Page = {
    downloadStatus: [createDownloadItem({ downloadId: 'a' })],
  };

  it('starts checking for a page that arrived mid-download', () => {
    // SWR passes nothing until it has fetched for itself, and sets its first
    // timer from that.
    const interval = refreshIntervalHelper<Page>((page) => page, downloading);
    assert.equal(interval(undefined), 5_000);
  });

  it('goes by the latest answer once there is one', () => {
    const interval = refreshIntervalHelper<Page>((page) => page, downloading);
    assert.equal(interval({ downloadStatus: [] }), 0);
    assert.equal(interval({ downloadStatus: [], waiting: true }), 30_000);
  });

  it('leaves a page with nothing on its way alone', () => {
    assert.equal(refreshIntervalHelper<Page>((page) => page)(undefined), 0);
  });
});

describe('watching a title for a download to start', () => {
  const interval = refreshIntervalHelper(watchMedia);

  it('keeps checking while it is requested or here only in part', () => {
    // A request card loaded before Backfill (or Radarr) started downloading.
    assert.equal(interval({ status: MediaStatus.PROCESSING }), 30_000);
    assert.equal(interval({ status: MediaStatus.PARTIALLY_AVAILABLE }), 30_000);
    assert.equal(
      interval({
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.PROCESSING,
      }),
      30_000
    );
  });

  it('checks often while downloading, and not at all once it is here', () => {
    assert.equal(
      interval({
        status: MediaStatus.AVAILABLE,
        downloadStatus: [createDownloadItem({ downloadId: 'x' })],
      }),
      5_000
    );
    assert.equal(interval({ status: MediaStatus.AVAILABLE }), 0);
    assert.equal(interval(undefined), 0);
  });
});
