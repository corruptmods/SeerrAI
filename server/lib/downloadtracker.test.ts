import { MediaType } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import { downloadStageOf, withLiveProgress } from '@server/lib/downloadtracker';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * What Radarr and Sonarr report at each point of a SABnzbd download, as
 * their code sets it: SABnzbd's queue gives queued, paused or downloading;
 * once SABnzbd moves it to its history, verifying, repairing, unpacking and
 * running the post-processing script all read as downloading with nothing
 * left, and done as completed, until Radarr or Sonarr imports it.
 */
const size = 4_000_000_000;

describe('where a download stands', () => {
  it('in the client', () => {
    assert.equal(
      downloadStageOf({ status: 'queued', size, sizeleft: size }),
      'queued'
    );
    assert.equal(
      downloadStageOf({ status: 'paused', size, sizeleft: size }),
      'paused'
    );
    assert.equal(
      downloadStageOf({
        status: 'downloading',
        trackedDownloadState: 'downloading',
        trackedDownloadStatus: 'ok',
        size,
        sizeleft: 1_000_000_000,
      }),
      'downloading'
    );
  });

  it('while SABnzbd unpacks or runs its script', () => {
    assert.equal(
      downloadStageOf({
        status: 'downloading',
        trackedDownloadState: 'downloading',
        trackedDownloadStatus: 'ok',
        size,
        sizeleft: 0,
      }),
      'finishing'
    );
  });

  it('done in SABnzbd and waiting for, or in, the import', () => {
    for (const trackedDownloadState of ['importPending', 'importing']) {
      assert.equal(
        downloadStageOf({
          status: 'completed',
          trackedDownloadState,
          trackedDownloadStatus: 'ok',
          size,
          sizeleft: 0,
        }),
        'importing',
        trackedDownloadState
      );
    }
  });

  it('when Radarr or Sonarr will not import it alone', () => {
    assert.equal(
      downloadStageOf({
        status: 'completed',
        trackedDownloadState: 'importBlocked',
        trackedDownloadStatus: 'warning',
        size,
        sizeleft: 0,
      }),
      'needsAttention'
    );
    assert.equal(
      downloadStageOf({
        status: 'completed',
        trackedDownloadState: 'importPending',
        trackedDownloadStatus: 'warning',
        size,
        sizeleft: 0,
      }),
      'needsAttention',
      'pending, but with a problem'
    );
    assert.equal(
      downloadStageOf({ status: 'downloadClientUnavailable', size }),
      'needsAttention'
    );
  });

  it('when it failed', () => {
    assert.equal(
      downloadStageOf({
        status: 'failed',
        trackedDownloadState: 'failedPending',
        trackedDownloadStatus: 'error',
        size,
        sizeleft: 0,
      }),
      'failed'
    );
  });

  it('while a delay profile holds it, with no estimate of its own', () => {
    // As the live Sonarr queue had it: the time given is when the hold ends.
    assert.equal(
      downloadStageOf({
        status: 'delay',
        size: 7_569_770_889,
        sizeleft: 7_569_770_889,
        estimatedCompletionTime: '2026-10-05T23:36:05Z',
      }),
      'waiting'
    );
  });
});

/*
 * qBittorrent, as Radarr and Sonarr report each of its states: paused and
 * stopped as paused; queued, checking and fetching metadata as queued;
 * downloading, forced and moving as downloading; stalled, errored, missing
 * files and metadata without DHT as a warning; seeding in any form as
 * completed. A torrent still seeding after import leaves their queue.
 */
describe('where a torrent stands', () => {
  const torrent = (status: string, sizeleft: number, extra = {}) =>
    downloadStageOf({
      status,
      trackedDownloadState: 'downloading',
      trackedDownloadStatus: status === 'warning' ? 'warning' : 'ok',
      size,
      sizeleft,
      ...extra,
    });

  it('before and while it downloads', () => {
    assert.equal(torrent('paused', size), 'paused');
    assert.equal(torrent('queued', size), 'queued', 'queuedDL, metaDL');
    assert.equal(torrent('queued', size / 2), 'queued', 'checkingDL');
    assert.equal(torrent('downloading', size / 2), 'downloading');
  });

  it('stalled, or stopped on an error, part-way', () => {
    assert.equal(torrent('warning', size / 2), 'stalled', 'stalledDL');
    assert.equal(torrent('warning', size), 'stalled', 'metaDL without DHT');
  });

  it('moving or re-checking once it is all in', () => {
    assert.equal(torrent('downloading', 0), 'finishing', 'moving');
    assert.equal(torrent('queued', 0), 'finishing', 'checkingUP');
  });

  it('seeding while it is imported', () => {
    assert.equal(
      torrent('completed', 0, { trackedDownloadState: 'importPending' }),
      'importing'
    );
  });

  it('missing its files once complete', () => {
    assert.equal(torrent('warning', 0), 'needsAttention', 'missingFiles');
  });

  it('when the import is blocked, seeding or not', () => {
    assert.equal(
      torrent('completed', 0, {
        trackedDownloadState: 'importBlocked',
        trackedDownloadStatus: 'warning',
      }),
      'needsAttention'
    );
  });
});

describe('a queue item brought up to date by its download client', () => {
  const item = (stage: DownloadingItem['stage'], status = 'downloading') =>
    ({
      mediaType: MediaType.MOVIE,
      externalId: 1,
      size: 1000,
      sizeLeft: 900,
      status,
      stage,
      timeLeft: '00:10:00',
      estimatedCompletionTime: new Date(0),
      title: 'A film',
      downloadId: 'SABnzbd_nzo_one',
    }) satisfies DownloadingItem;
  const now = Date.parse('2026-10-05T12:00:00Z');

  it('takes the progress, time left and step from the client', () => {
    const merged = withLiveProgress(
      item('downloading'),
      { size: 1000, sizeLeft: 100, stage: 'downloading', secondsLeft: 60 },
      now
    );
    assert.deepEqual(
      [merged.sizeLeft, merged.stage, merged.estimatedCompletionTime],
      [100, 'downloading', new Date(now + 60_000)]
    );
    const finishing = withLiveProgress(
      item('downloading'),
      { size: 1000, sizeLeft: 0, stage: 'finishing', step: 'unpacking' },
      now
    );
    assert.deepEqual(
      [finishing.stage, finishing.step, finishing.estimatedCompletionTime],
      ['finishing', 'unpacking', undefined]
    );
  });

  it("leaves imports, blocks, failures and holds to Radarr's word", () => {
    for (const stage of [
      'importing',
      'needsAttention',
      'failed',
      'waiting',
    ] as const) {
      const merged = withLiveProgress(
        item(stage),
        { size: 1000, sizeLeft: 0, stage: 'importing' },
        now
      );
      assert.deepEqual([merged.stage, merged.step], [stage, undefined], stage);
    }
  });

  it('trusts the client over "client unavailable", having just reached it', () => {
    const merged = withLiveProgress(
      item('needsAttention', 'downloadClientUnavailable'),
      { size: 1000, sizeLeft: 500, stage: 'downloading', secondsLeft: 30 },
      now
    );
    assert.equal(merged.stage, 'downloading');
  });

  it('keeps the queue size when the client does not know it yet', () => {
    const merged = withLiveProgress(
      item('queued', 'queued'),
      { size: 0, sizeLeft: 0, stage: 'queued' },
      now
    );
    assert.deepEqual([merged.size, merged.sizeLeft], [1000, 900]);
  });

  it('is the queue item as it was without a reading', () => {
    const plain = item('downloading');
    assert.equal(withLiveProgress(plain, undefined, now), plain);
  });
});
