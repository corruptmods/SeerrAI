import type { LidarrRelease } from '@server/api/servarr/lidarr';
import { bestRelease } from '@server/lib/music/songRelease';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Which release of an album songs are taken into, from the editions as
 * Lidarr lists them. Shaped on a real album and single: Lidarr's own pick
 * for the album was a 49-track bootleg box.
 */

let nextId = 1;
const release = (
  foreignReleaseId: string,
  init: Partial<LidarrRelease>
): LidarrRelease => ({
  id: nextId++,
  albumId: 1,
  foreignReleaseId,
  title: 'Static Garden',
  monitored: false,
  status: 'Official',
  ...init,
});

describe('the release songs are taken into', () => {
  const album = [
    release('box', {
      status: 'Bootleg',
      trackCount: 49,
      format: '4xDigital Media',
      monitored: true,
    }),
    release('cd', { trackCount: 13, format: 'CD', country: ['Europe'] }),
    release('web', {
      trackCount: 13,
      format: 'Digital Media',
      country: ['[Worldwide]'],
    }),
    release('web-jp', { trackCount: 14, format: 'Digital Media' }),
    release('deluxe', { trackCount: 22, format: '2xDigital Media' }),
    release('lp', { trackCount: 13, format: '2x12" Vinyl' }),
  ];

  it('is the usual official edition with the song, digital first', () => {
    const recordings = new Map([
      ['song', new Set(['box', 'cd', 'web', 'web-jp', 'deluxe', 'lp'])],
    ]);
    assert.equal(bestRelease(album, recordings)?.foreignReleaseId, 'web');
  });

  it('is one with every song asked for, over a likelier one with fewer', () => {
    const recordings = new Map([
      ['song', new Set(['cd', 'web', 'deluxe'])],
      ['bonus', new Set(['deluxe'])],
    ]);
    assert.equal(bestRelease(album, recordings)?.foreignReleaseId, 'deluxe');
  });

  it('is none when no edition has the songs', () => {
    const recordings = new Map([['song', new Set(['elsewhere'])]]);
    assert.equal(bestRelease(album, recordings), undefined);
  });

  it('for a single, is the edition with the version asked for', () => {
    const single = [
      release('vinyl', {
        trackCount: 3,
        format: '12" Vinyl',
        country: ['[Worldwide]'],
        monitored: true,
      }),
      release('cd', { trackCount: 2, format: 'CD' }),
      release('promo', { status: 'Promotion', trackCount: 1, format: 'CD-R' }),
      release('digital', {
        trackCount: 1,
        format: 'Digital Media',
        country: ['[Worldwide]'],
      }),
    ];
    const radioEdit = new Map([
      ['radio edit', new Set(['vinyl', 'promo', 'digital'])],
    ]);
    assert.equal(bestRelease(single, radioEdit)?.foreignReleaseId, 'digital');
  });

  it('keeps the edition Lidarr has when another is no better', () => {
    const twins = [
      release('a', { trackCount: 13, format: 'Digital Media' }),
      release('b', {
        trackCount: 13,
        format: 'Digital Media',
        monitored: true,
      }),
    ];
    const recordings = new Map([['song', new Set(['a', 'b'])]]);
    assert.equal(bestRelease(twins, recordings)?.foreignReleaseId, 'b');
  });
});
