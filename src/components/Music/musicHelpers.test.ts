import type { MusicAlbumResult } from '@server/models/Music';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  albumGroup,
  artistImageUrl,
  byNewest,
  musicImageSrc,
  trackLength,
  yearOf,
} from './musicHelpers';

/* What the music pages show: pictures, album groups, dates and lengths. */

const album = (
  primaryType: string | undefined,
  secondaryTypes: string[] = [],
  releaseDate?: string
): MusicAlbumResult => ({
  mediaType: 'album',
  id: 'x',
  title: 'x',
  primaryType,
  secondaryTypes,
  releaseDate,
  coverUrl: '',
});

describe('music pictures', () => {
  it('come through the image proxy when the server caches images', () => {
    const cover =
      'https://coverartarchive.org/release-group/b1392450-e666-3926-a536-22c65f834433/front-500';
    assert.equal(
      musicImageSrc(cover, true),
      '/imageproxy/caa/release-group/b1392450-e666-3926-a536-22c65f834433/front-500'
    );
    assert.equal(musicImageSrc(cover, false), cover);
    assert.equal(
      musicImageSrc('https://assets.fanart.tv/fanart/music/x/a/b.jpg', true),
      '/imageproxy/fanart/fanart/music/x/a/b.jpg'
    );
    // The artist picture route already decides for itself.
    assert.equal(
      musicImageSrc('/api/v1/music/artist/x/image', true),
      '/api/v1/music/artist/x/image'
    );
  });

  it('of an artist are asked of the server', () => {
    assert.equal(artistImageUrl('abc'), '/api/v1/music/artist/abc/image');
    assert.equal(
      artistImageUrl('abc', 'backdrop'),
      '/api/v1/music/artist/abc/image?kind=backdrop'
    );
  });
});

describe('an artist’s albums', () => {
  it('are grouped as albums, EPs, singles and the rest', () => {
    assert.equal(albumGroup(album('Album')), 'albums');
    assert.equal(albumGroup(album('EP')), 'eps');
    assert.equal(albumGroup(album('Single')), 'singles');
    assert.equal(albumGroup(album('Album', ['Live'])), 'other');
    assert.equal(albumGroup(album('Broadcast')), 'other');
    assert.equal(albumGroup(album(undefined)), 'other');
  });

  it('go newest first, undated last', () => {
    const sorted = [
      album('Album', [], '1997-05-21'),
      album('Album'),
      album('Album', [], '2003'),
    ].sort(byNewest);
    assert.deepEqual(
      sorted.map((a) => a.releaseDate),
      ['2003', '1997-05-21', undefined]
    );
  });
});

describe('dates and lengths', () => {
  it('show the year however precise the date', () => {
    assert.equal(yearOf('2004'), '2004');
    assert.equal(yearOf('2004-03-15'), '2004');
    assert.equal(yearOf(undefined), undefined);
    assert.equal(yearOf(''), undefined);
  });

  it('show a track’s length as people read it', () => {
    assert.equal(trackLength(199000), '3:19');
    assert.equal(trackLength(3_765_000), '1:02:45');
    assert.equal(trackLength(5_000), '0:05');
    assert.equal(trackLength(null), undefined);
  });
});
