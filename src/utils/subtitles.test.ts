import type {
  EpisodeSubtitles,
  SubtitleTrack,
} from '@server/interfaces/api/subtitlesInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatOf,
  formatSize,
  groupMissing,
  groupTracks,
  isCovered,
  providerName,
  ranges,
  whereAre,
} from './subtitles';

const track = (fields: Partial<SubtitleTrack>): SubtitleTrack => ({
  id: 1,
  language: 'en',
  name: 'English',
  kind: 'file',
  hi: false,
  forced: false,
  fileName: 'Show - S01E01.en.srt',
  ai: false,
  ...fields,
});

const episode = (
  seasonNumber: number,
  episodeNumber: number,
  tracks: SubtitleTrack[],
  missing = false
): EpisodeSubtitles => ({
  seasonNumber,
  episodeNumber,
  title: '',
  tracks,
  missing: missing
    ? [{ language: 'en', name: 'English', hi: false, forced: false }]
    : [],
});

/** The shape of the real BRIXO Shurikan: Wyverns Waking. */
const series = [
  ...[1, 2, 3].flatMap((s) =>
    Array.from({ length: 20 }, (_, i) => episode(s, i + 1, [track({})]))
  ),
  ...Array.from({ length: 10 }, (_, i) =>
    episode(4, i + 1, [track({ kind: 'embedded', fileName: undefined })])
  ),
  ...[11, 12, 13, 14, 15, 16, 17, 19, 20].map((n) => episode(4, n, [], true)),
  episode(4, 18, [track({ ai: true })]),
];

describe('describing subtitles', () => {
  it('names a subtitle’s format', () => {
    assert.equal(formatOf(track({})), 'SRT');
    assert.equal(formatOf(track({ fileName: 'x.en.ass' })), 'ASS');
    assert.equal(
      formatOf(track({ kind: 'embedded', fileName: undefined })),
      'IN VIDEO'
    );
    assert.equal(formatSize(54358), '53\u00a0KB');
    assert.equal(formatSize(undefined), undefined);
  });

  it('groups a series’ subtitles by language and kind', () => {
    const groups = groupTracks(series, ['en']);
    assert.deepEqual(
      groups.map((g) => [g.format, g.ai, g.episodes.length]),
      [
        ['SRT', false, 60],
        ['IN VIDEO', false, 10],
        ['SRT', true, 1],
      ]
    );
    assert.deepEqual(whereAre(groups[0].episodes, series), {
      kind: 'seasons',
      seasons: [1, 2, 3],
    });
    assert.deepEqual(whereAre(groups[1].episodes, series), {
      kind: 'episodes',
      season: 4,
      episodes: '1–10',
    });
    assert.deepEqual(whereAre(groups[2].episodes, series), {
      kind: 'episodes',
      season: 4,
      episodes: '18',
    });
  });

  it('groups what is missing, by language', () => {
    const [missing] = groupMissing(series);
    assert.equal(missing.episodes.length, 9);
    assert.deepEqual(whereAre(missing.episodes, series), {
      kind: 'episodes',
      season: 4,
      episodes: '11–17, 19–20',
    });
    assert.equal(series.filter(isCovered).length, 71);
  });

  it('writes runs of numbers short', () => {
    assert.equal(ranges([3, 1, 2, 5, 7, 8]), '1–3, 5, 7–8');
    assert.equal(ranges([]), '');
  });

  it('names providers as people know them', () => {
    assert.equal(providerName('opensubtitlescom'), 'OpenSubtitles.com');
    assert.equal(providerName('whisperai'), 'Whisper');
    assert.equal(providerName('newone'), 'Newone');
  });
});
