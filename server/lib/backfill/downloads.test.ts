import { MediaType } from '@server/constants/media';
import type BackfillJob from '@server/entity/BackfillJob';
import type BackfillSeries from '@server/entity/BackfillSeries';
import {
  backfillDownloadsOf,
  backfillImportsOf,
} from '@server/lib/backfill/progress';
import downloadTracker from '@server/lib/downloadtracker';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

/*
 * Backfill's own downloads (the admin agent's too) show on title pages and
 * cards like any download Radarr or Sonarr runs.
 */

const file = (episodeId: number, episode: number, state = 'waiting') => ({
  index: episode,
  path: `pack/E${episode}.mkv`,
  size: 400,
  judgedAs: '',
  episodeIds: [episodeId],
  season: 1,
  episode,
  score: 0,
  action: 'fill' as const,
  replaces: 0,
  state: state as 'waiting',
});

const job = (over: Partial<BackfillJob>, series: Partial<BackfillSeries>) =>
  ({
    id: 52,
    title: 'Wendle collection',
    status: 'downloading',
    downloadId: 'a6df2f46',
    size: 1200,
    sizeLeft: 600,
    secondsLeft: 90,
    files: [file(501, 1), file(502, 2), file(503, 3, 'imported')],
    series: { kind: 'series', serverId: 0, arrId: 1283, ...series },
    ...over,
  }) as unknown as BackfillJob;

afterEach(() => downloadTracker.resetDownloadTracker());

describe('Backfill downloads on title pages', () => {
  it('shows each episode still to come, with its share of what is left', () => {
    const now = Date.parse('2026-10-07T20:00:00Z');
    const items = backfillDownloadsOf(job({}, {}), now);
    assert.deepEqual(
      items.map((d) => [
        d.kind,
        d.serverId,
        d.item.externalId,
        d.item.episode?.episodeNumber,
        d.item.size,
        d.item.sizeLeft,
        d.item.stage,
      ]),
      [
        ['series', 0, 1283, 1, 400, 200, 'downloading'],
        ['series', 0, 1283, 2, 400, 200, 'downloading'],
      ]
    );
    assert.equal(items[0].item.title, 'Backfill: Wendle collection');
    assert.equal(items[0].item.timeLeft, '00:01:30');
    assert.deepEqual(
      items[0].item.estimatedCompletionTime,
      new Date(now + 90_000)
    );

    downloadTracker.setBackfillDownloads(items);
    assert.equal(downloadTracker.getSeriesProgress(0, 1283).length, 2);
    assert.equal(downloadTracker.getSeriesProgress(0, 9).length, 0);
    assert.equal(downloadTracker.getMovieProgress(0, 1283).length, 0);
  });

  it('shows a movie as one download, paused as paused', () => {
    const items = backfillDownloadsOf(
      job({ status: 'paused', files: [] }, { kind: 'movie', arrId: 3801 })
    );
    assert.deepEqual(
      items.map((d) => [
        d.kind,
        d.item.mediaType,
        d.item.externalId,
        d.item.stage,
        d.item.sizeLeft,
      ]),
      [['movie', MediaType.MOVIE, 3801, 'paused', 600]]
    );
    downloadTracker.setBackfillDownloads(items);
    assert.equal(downloadTracker.getMovieProgress(0, 3801).length, 1);
  });
});

describe('what Backfill has imported, on title pages', () => {
  it('shows it as being added to the library, not as gone', () => {
    downloadTracker.whenImported(() => undefined);
    const running = job({}, {});
    downloadTracker.setBackfillDownloads(backfillDownloadsOf(running));
    assert.equal(downloadTracker.getSeriesProgress(0, 1283).length, 2);

    // Episode 1 is imported; episode 2 is still to come.
    const later = job(
      {
        files: [
          file(501, 1, 'imported'),
          file(502, 2),
          file(503, 3, 'imported'),
        ],
      },
      {}
    );
    downloadTracker.setBackfillDownloads(
      backfillDownloadsOf(later),
      backfillImportsOf(later)
    );
    assert.deepEqual(
      downloadTracker
        .getSeriesProgress(0, 1283)
        .map((i) => [i.episode?.episodeNumber, i.stage]),
      [
        [2, 'downloading'],
        [1, 'imported'],
      ]
    );
    // Episode 3, imported before this page saw it downloading, is not.

    // The media server lists the series: no longer shown.
    downloadTracker.forgetImported('series', 0, 1283);
    downloadTracker.setBackfillDownloads(
      backfillDownloadsOf(later),
      backfillImportsOf(later)
    );
    assert.deepEqual(
      downloadTracker
        .getSeriesProgress(0, 1283)
        .map((i) => [i.episode?.episodeNumber, i.stage]),
      [[2, 'downloading']]
    );
  });

  it('shows a movie being added once its job is done, not when it fails', () => {
    downloadTracker.whenImported(() => undefined);
    const movie = { kind: 'movie' as const, arrId: 3801 };
    const running = job({ files: [] }, movie);
    downloadTracker.setBackfillDownloads(backfillDownloadsOf(running));

    const failed = job({ files: [], status: 'failed' }, movie);
    assert.deepEqual(backfillImportsOf(failed), []);

    const done = job({ files: [], status: 'done', imported: 1 }, movie);
    downloadTracker.setBackfillDownloads([], backfillImportsOf(done));
    assert.deepEqual(
      downloadTracker.getMovieProgress(0, 3801).map((i) => i.stage),
      ['imported']
    );
  });
});

describe("a Usenet download's own speed", () => {
  it("measures what it gained when SABnzbd's one speed is not its own", async () => {
    const { default: backfill } = await import('@server/lib/backfill/engine');
    const paced = (
      backfill as unknown as {
        paced: (
          id: number,
          reading: {
            progress: number;
            size: number;
            sizeLeft: number;
            speed: number;
            secondsLeft: number | null;
          },
          reported: number | undefined,
          now: number
        ) => { speed: number; secondsLeft: number | null };
      }
    ).paced.bind(backfill);
    const MB = 1024 * 1024;
    const reading = (left: number, secondsLeft: number | null = 999) => ({
      progress: 0,
      size: 1000 * MB,
      sizeLeft: left * MB,
      speed: 0,
      secondsLeft,
    });
    // Nothing to compare with yet: no speed made up.
    assert.equal(paced(901, reading(900), undefined, 0).speed, 0);
    // 100 MB in 10 seconds is 10 MB/s, and the time left follows from it.
    const later = paced(901, reading(800), undefined, 10_000);
    assert.equal(later.speed, 10 * MB);
    assert.equal(later.secondsLeft, 80);
    // A reading a moment later keeps that speed, not a jumpy one.
    assert.equal(paced(901, reading(799), undefined, 11_000).speed, 10 * MB);
    // SABnzbd's own figure, when it is this job's, is taken as it is.
    const own = paced(901, reading(700, 30), 5 * MB, 20_000);
    assert.equal(own.speed, 5 * MB);
    assert.equal(own.secondsLeft, 30);
  });
});

describe('what a Usenet download is doing, in words', () => {
  it('says what the client is doing after the download, not its bare status', async () => {
    const { usenetStage } = await import('@server/lib/backfill/progress');
    assert.equal(
      usenetStage({ place: 'history', status: 'Running' }, 'SABnzbd'),
      'SABnzbd is running its post-processing script'
    );
    assert.equal(
      usenetStage({ place: 'history', status: 'Extracting' }, 'SABnzbd'),
      'SABnzbd is unpacking it'
    );
    assert.equal(
      usenetStage({ place: 'queue', status: 'Queued' }, 'SABnzbd'),
      'Waiting its turn in SABnzbd'
    );
    // NZBGet's are put in the same words.
    assert.equal(
      usenetStage({ place: 'history', status: 'renaming' }, 'NZBGet'),
      'NZBGet is renaming its files'
    );
    // Anything new is shown as the client names it.
    assert.equal(
      usenetStage({ place: 'history', status: 'Odd' }, 'SABnzbd'),
      'Odd'
    );
  });

  it('says what a torrent is doing in the words of its own client', async () => {
    const { torrentStage } = await import('@server/lib/backfill/progress');
    assert.deepEqual(torrentStage({ state: 'paused', speed: 0 }, 'Deluge'), {
      stage: 'Paused in Deluge',
      held: true,
    });
    assert.deepEqual(
      torrentStage({ state: 'checking', speed: 0 }, 'Transmission'),
      { stage: 'Transmission is checking it', held: true }
    );
    assert.deepEqual(
      torrentStage({ state: 'downloading', speed: 0 }, 'rTorrent'),
      { stage: 'Waiting for peers', held: false }
    );
  });
});
