import { MediaType } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  downloadBadgeLabel,
  episodeSpan,
  isDownloadBusy,
  isOneRelease,
  releasesOf,
  secondsLeft,
  summarizeDownloads,
} from './downloadSummary';

const item = (fields: Partial<DownloadingItem>): DownloadingItem =>
  ({
    mediaType: 'movie',
    externalId: 1,
    size: 1000,
    sizeLeft: 0,
    status: 'downloading',
    stage: 'downloading',
    timeLeft: '',
    title: 'Release',
    downloadId: 'one',
    ...fields,
  }) as DownloadingItem;

const episode = (episodeNumber: number) => ({
  seasonNumber: 1,
  episodeNumber,
  absoluteEpisodeNumber: episodeNumber,
  id: episodeNumber,
});

describe('summarizing a title’s downloads for its badge', () => {
  it('has nothing to say with no downloads', () => {
    assert.equal(summarizeDownloads([]), undefined);
  });

  it('counts a season pack once, not once per episode', () => {
    const pack = { downloadId: 'pack', size: 1000, sizeLeft: 750 };
    const summary = summarizeDownloads([
      item({ ...pack, episode: episode(1) }),
      item({ ...pack, episode: episode(2) }),
      item({ ...pack, episode: episode(3) }),
      item({ downloadId: 'single', size: 1000, sizeLeft: 250 }),
    ]);
    // 250 + 750 of 2000, not 250 * 3 + 750 of 4000.
    assert.equal(summary?.percent, 50);
  });

  it('follows every download, not just the first', () => {
    const summary = summarizeDownloads([
      item({ downloadId: 'a', size: 100, sizeLeft: 0, stage: 'importing' }),
      item({ downloadId: 'b', size: 300, sizeLeft: 300 }),
    ]);
    assert.equal(summary?.percent, 25);
  });

  it('has no percentage before a torrent knows its size', () => {
    const summary = summarizeDownloads([
      item({ size: 0, sizeLeft: 0, stage: 'queued', step: 'metadata' }),
    ]);
    assert.deepEqual(summary, {
      stage: 'queued',
      step: 'metadata',
      percent: undefined,
    });
  });

  it('keeps a bad reading between 0 and 100', () => {
    assert.equal(
      summarizeDownloads([item({ size: 100, sizeLeft: 400 })])?.percent,
      0
    );
    assert.equal(
      summarizeDownloads([item({ size: 100, sizeLeft: -5 })])?.percent,
      100
    );
    assert.equal(
      summarizeDownloads([item({ size: NaN, sizeLeft: 5 })])?.percent,
      undefined
    );
  });

  it('names what is happening before what is holding it up', () => {
    const stageOf = (...stages: DownloadingItem['stage'][]) =>
      summarizeDownloads(
        stages.map((stage, i) => item({ downloadId: `d${i}`, stage }))
      )?.stage;
    assert.equal(stageOf('stalled', 'downloading'), 'downloading');
    assert.equal(stageOf('importing', 'finishing'), 'finishing');
    assert.equal(
      stageOf('queued', 'stalled', 'needsAttention'),
      'needsAttention'
    );
    assert.equal(stageOf('paused', 'stalled'), 'stalled');
    assert.equal(stageOf('waiting', 'queued'), 'queued');
  });

  it('keeps the step of the download it names', () => {
    const summary = summarizeDownloads([
      item({ downloadId: 'a', stage: 'queued', step: 'metadata' }),
      item({ downloadId: 'b', stage: 'stalled', step: 'noPeers' }),
    ]);
    assert.deepEqual([summary?.stage, summary?.step], ['stalled', 'noPeers']);
  });

  it('counts a copy saved before stages as downloading', () => {
    const old = item({}) as Partial<DownloadingItem>;
    delete old.stage;
    assert.equal(
      summarizeDownloads([old as DownloadingItem])?.stage,
      'downloading'
    );
  });
});

describe('the badge’s words', () => {
  it('says what the client is doing, not "Processing"', () => {
    const cases: [DownloadingItem['stage'], DownloadingItem['step'], string][] =
      [
        ['downloading', undefined, 'downloading'],
        ['stalled', 'noPeers', 'stalled'],
        ['queued', 'metadata', 'gettingDetails'],
        ['queued', 'checking', 'checking'],
        ['queued', undefined, 'queued'],
        ['paused', undefined, 'paused'],
        ['waiting', undefined, 'waiting'],
        ['finishing', 'verifying', 'verifying'],
        ['finishing', 'repairing', 'repairing'],
        ['finishing', 'unpacking', 'unpacking'],
        ['finishing', 'moving', 'moving'],
        ['finishing', 'script', 'runningScript'],
        ['finishing', 'checking', 'checking'],
        ['finishing', undefined, 'finishing'],
        ['importing', undefined, 'importing'],
        ['needsAttention', undefined, 'needsAttention'],
        ['failed', undefined, 'failed'],
      ];
    for (const [stage, step, label] of cases) {
      assert.equal(downloadBadgeLabel({ stage, step }), label, stage);
    }
  });

  it('spins only while something is happening', () => {
    assert.equal(isDownloadBusy({ stage: 'downloading' }), true);
    assert.equal(isDownloadBusy({ stage: 'finishing' }), true);
    assert.equal(isDownloadBusy({ stage: 'importing' }), true);
    assert.equal(isDownloadBusy({ stage: 'queued', step: 'metadata' }), true);
    assert.equal(isDownloadBusy({ stage: 'queued' }), false);
    assert.equal(isDownloadBusy({ stage: 'stalled', step: 'noPeers' }), false);
    assert.equal(isDownloadBusy({ stage: 'paused' }), false);
    assert.equal(isDownloadBusy({ stage: 'needsAttention' }), false);
    assert.equal(isDownloadBusy({ stage: 'failed' }), false);
    assert.equal(isDownloadBusy({ stage: 'waiting' }), false);
  });
});

describe('naming the episodes a series’ badge is about', () => {
  const held = (n: number) =>
    item({
      mediaType: MediaType.TV,
      downloadId: '',
      stage: 'waiting',
      title: 'Show (2026) S01 1080p WEB',
      episode: episode(n),
    });

  it('names the episode when there is one', () => {
    assert.deepEqual(episodeSpan([item({ episode: episode(3) })]), {
      kind: 'episode',
      season: 1,
      episode: 3,
    });
  });

  it('names the season for a pack, even one held back with no download yet', () => {
    const items = [held(3), held(1), held(2)];
    assert.equal(isOneRelease(items), true);
    assert.deepEqual(episodeSpan(items), { kind: 'season', season: 1 });
    // Its size counts once.
    assert.equal(releasesOf(items).length, 1);
    assert.equal(releasesOf(items)[0].episodes, 3);
  });

  it('names the stretch for separate downloads in a season', () => {
    const items = [
      item({ downloadId: 'a', episode: episode(5) }),
      item({ downloadId: 'b', episode: episode(3) }),
    ];
    assert.equal(isOneRelease(items), false);
    assert.deepEqual(episodeSpan(items), {
      kind: 'episodes',
      season: 1,
      first: 3,
      last: 5,
    });
  });

  it('names the seasons when several are downloading', () => {
    assert.deepEqual(
      episodeSpan([
        item({ downloadId: 'a', episode: { ...episode(1), seasonNumber: 3 } }),
        item({ downloadId: 'b', episode: episode(2) }),
      ]),
      { kind: 'seasons', first: 1, last: 3 }
    );
  });

  it('has nothing to name for a movie', () => {
    assert.equal(episodeSpan([item({})]), undefined);
  });
});

describe('how long Radarr or Sonarr holds a release', () => {
  it('reads their time left, with or without days', () => {
    assert.equal(secondsLeft('01:37:25.8878288'), 5845);
    assert.equal(secondsLeft('1.02:00:00'), 93600);
    assert.equal(secondsLeft('00:00:00'), undefined);
    assert.equal(secondsLeft(''), undefined);
    assert.equal(secondsLeft(undefined), undefined);
  });
});
