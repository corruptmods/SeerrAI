import type { LidarrTrack } from '@server/api/servarr/lidarr';
import type { SlskdResponse } from '@server/api/slskd';
import { slskdNewEnough, transferIs } from '@server/api/slskd';
import type SongRequest from '@server/entity/SongRequest';
import {
  chooseSharer,
  mergeResponses,
  soulseekQuery,
} from '@server/lib/music/soulseekSongs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Picking song files from Soulseek results: named as the song, with the
 * artist, same take and length, from the best sharer. Names are invented.
 */

const MB = 1024 ** 2;

const wanted = (
  title: string,
  duration?: number
): { song: SongRequest; track: LidarrTrack } => ({
  song: { recordingMbid: `rec-${title}` } as SongRequest,
  track: {
    id: 500 + title.length,
    albumId: 1,
    title,
    duration,
    hasFile: false,
  },
});

const sharer = (
  username: string,
  files: [string, number?][],
  more: Partial<SlskdResponse> = {}
): SlskdResponse => ({
  username,
  files: files.map(([filename, length]) => ({
    filename,
    size: 30 * MB,
    length: length ?? null,
  })),
  hasFreeUploadSlot: true,
  queueLength: 0,
  uploadSpeed: 100_000,
  ...more,
});

describe('the Soulseek sharer songs are taken from', () => {
  it('has the song’s own file, by the artist, never a live album’s', () => {
    const choice = chooseSharer(
      [
        sharer('a', [['Glasswing\\Live at the Pier\\03 - Lantern Song.flac']]),
        sharer('b', [['Static Garden\\03 - Lantern Song.flac']]),
        sharer('c', [['Glasswing\\Static Garden\\03 - Lantern Song.mp3']]),
      ],
      [wanted('Lantern Song')],
      'Static Garden',
      'Glasswing',
      new Set()
    );
    // b's file names no artist anywhere; a's is the live album's.
    assert.equal(choice?.username, 'c');
    assert.equal(choice?.folder, 'Glasswing\\Static Garden');
    assert.deepEqual(
      choice?.files.map((f) => [f.path, f.trackId, f.recordingMbid]),
      [
        [
          'Glasswing\\Static Garden\\03 - Lantern Song.mp3',
          512,
          'rec-Lantern Song',
        ],
      ]
    );
  });

  it('is as long as the track, when both are known', () => {
    const files = (seconds: number): [string, number][] => [
      ['Glasswing - Lantern Song.flac', seconds],
    ];
    const pick = (seconds: number) =>
      chooseSharer(
        [sharer('a', files(seconds))],
        [wanted('Lantern Song', 214_000)],
        'Static Garden',
        'Glasswing',
        new Set()
      )?.username;
    assert.equal(pick(215), 'a');
    assert.equal(pick(305), undefined);
  });

  it('has the most of the songs, then a free slot, a short queue, lossless files', () => {
    const both: [string][] = [
      ['Glasswing\\Static Garden\\01 - Opening.mp3'],
      ['Glasswing\\Static Garden\\02 - Lantern Song.mp3'],
    ];
    const songs = [wanted('Opening'), wanted('Lantern Song')];
    const pick = (responses: SlskdResponse[], passOver = new Set<string>()) =>
      chooseSharer(responses, songs, 'Static Garden', 'Glasswing', passOver)
        ?.username;
    assert.equal(
      pick([
        sharer('one', [['Glasswing\\Static Garden\\01 - Opening.flac']]),
        sharer('two', both, { hasFreeUploadSlot: false, queueLength: 40 }),
      ]),
      'two'
    );
    assert.equal(
      pick([
        sharer('busy', both, { hasFreeUploadSlot: false }),
        sharer('free', both),
      ]),
      'free'
    );
    assert.equal(
      pick([
        sharer('long', both, { queueLength: 9 }),
        sharer('short', both, { queueLength: 1 }),
      ]),
      'short'
    );
    assert.equal(
      pick([
        sharer('mp3', both, { uploadSpeed: 9_000_000 }),
        sharer('flac', [
          ['Glasswing\\Static Garden\\01 - Opening.flac'],
          ['Glasswing\\Static Garden\\02 - Lantern Song.flac'],
        ]),
      ]),
      'flac'
    );
    // Already-tried sharers are skipped.
    assert.equal(
      pick([sharer('tried', both), sharer('next', both)], new Set(['tried'])),
      'next'
    );
    assert.equal(pick([sharer('none', [['Glasswing\\cover.jpg']])]), undefined);
  });

  it('merges several searches’ answers, one for each sharer', () => {
    const merged = mergeResponses([
      [sharer('a', [['x\\Glasswing - Opening.flac']])],
      [
        sharer('a', [['x\\Glasswing - Lantern Song.flac']]),
        sharer('b', [['y\\Glasswing - Lantern Song.flac']]),
      ],
    ]);
    assert.deepEqual(
      merged.map((r) => [r.username, r.files.map((f) => f.filename)]),
      [
        [
          'a',
          ['x\\Glasswing - Opening.flac', 'x\\Glasswing - Lantern Song.flac'],
        ],
        ['b', ['y\\Glasswing - Lantern Song.flac']],
      ]
    );
  });

  it('merges a sharer with many files quickly, each file once, in first-seen order', () => {
    const list = (from: number) =>
      sharer(
        'a',
        Array.from({ length: 10_000 }, (_, i): [string] => [
          `x\\Static Garden\\${String(from + i).padStart(6, '0')} - Harbour Lights.flac`,
        ])
      );
    const started = performance.now();
    const merged = mergeResponses([[list(0)], [list(5_000)], [list(10_000)]]);
    assert.ok(performance.now() - started < 1000);
    const names = merged[0].files.map((f) => f.filename);
    assert.equal(names.length, 20_000);
    assert.equal(new Set(names).size, 20_000);
    assert.match(names[0], /000000/);
    assert.match(names[10_000], /010000/);
  });

  it('is searched for by the artist and title as words', () => {
    assert.equal(
      soulseekQuery('Glasswing & Harbour Lights', 'Lantern Song (Radio Edit)'),
      'glasswing and harbour lights lantern song radio edit'
    );
  });
});

describe('slskd', () => {
  it('downloads in batches from 0.26 on', () => {
    assert.equal(slskdNewEnough('0.26.0'), true);
    assert.equal(slskdNewEnough('0.26.2.65534'), true);
    assert.equal(slskdNewEnough('1.0.0'), true);
    assert.equal(slskdNewEnough('0.25.1'), false);
    assert.equal(slskdNewEnough(''), false);
  });

  it('reads a transfer’s state by its flags', () => {
    const t = { state: 'Completed, Succeeded' };
    assert.equal(transferIs(t, 'Completed'), true);
    assert.equal(transferIs(t, 'Succeeded'), true);
    assert.equal(transferIs({ state: 'Queued, Remotely' }, 'Completed'), false);
  });
});
