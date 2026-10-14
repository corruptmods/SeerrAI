import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import type { MusicAlbumResult } from '@server/models/Music';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  albumDownloads,
  albumGroup,
  allowedByProfile,
  artistImageUrl,
  byNewest,
  musicImageSrc,
  musicRequestStatus,
  requestable,
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
  });

  it('of an artist come from the image proxy’s own address for them', () => {
    const ID = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
    assert.equal(
      musicImageSrc(artistImageUrl(ID), true),
      `/imageproxy/artist/${ID}`
    );
    assert.equal(
      musicImageSrc(artistImageUrl(ID, 'backdrop'), true),
      `/imageproxy/artist/${ID}/backdrop`
    );
    // Not cached: the server sends the browser to the picture's own host.
    assert.equal(musicImageSrc(artistImageUrl(ID), false), artistImageUrl(ID));
    assert.equal(
      musicImageSrc('/api/v1/music/artist/not-an-id/image', true),
      '/api/v1/music/artist/not-an-id/image'
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

describe('what the request window ticks to begin with', () => {
  const standard = {
    primaryTypes: ['Album', 'EP'],
    secondaryTypes: ['Studio'],
  };

  it('follows the Lidarr metadata profile', () => {
    assert.equal(allowedByProfile(album('Album'), standard), true);
    assert.equal(allowedByProfile(album('ep'), standard), true);
    assert.equal(allowedByProfile(album('Single'), standard), false);
    assert.equal(allowedByProfile(album('Album', ['Live']), standard), false);
    assert.equal(allowedByProfile(album(undefined), standard), false);
    assert.equal(
      allowedByProfile(album('Album', ['Live', 'Compilation']), {
        primaryTypes: ['Album'],
        secondaryTypes: ['Live', 'Compilation'],
      }),
      true
    );
    assert.equal(
      allowedByProfile(album('Album'), {
        primaryTypes: ['Album'],
        secondaryTypes: ['Live'],
      }),
      false,
      'a studio album needs Studio allowed'
    );
  });

  it('leaves out albums already here or on their way', () => {
    assert.equal(requestable(undefined), true);
    assert.equal(requestable(MediaStatus.UNKNOWN), true);
    assert.equal(requestable(MediaStatus.DELETED), true);
    assert.equal(requestable(MediaStatus.PENDING), false);
    assert.equal(requestable(MediaStatus.PROCESSING), false);
    assert.equal(requestable(MediaStatus.AVAILABLE), false);
  });
});

describe('a music request card’s status', () => {
  const of = (
    status: MediaRequestStatus,
    albums: (MediaStatus | undefined)[]
  ) =>
    musicRequestStatus({
      status,
      albums: albums.map((albumStatus) => ({ albumStatus })),
    });

  it('follows the albums asked for, not the artist', () => {
    assert.equal(
      of(MediaRequestStatus.PENDING, [MediaStatus.PENDING]),
      MediaStatus.PENDING
    );
    assert.equal(
      of(MediaRequestStatus.APPROVED, [MediaStatus.PROCESSING]),
      MediaStatus.PROCESSING
    );
    assert.equal(
      of(MediaRequestStatus.APPROVED, [
        MediaStatus.AVAILABLE,
        MediaStatus.PROCESSING,
      ]),
      MediaStatus.PARTIALLY_AVAILABLE
    );
    assert.equal(
      of(MediaRequestStatus.COMPLETED, [
        MediaStatus.AVAILABLE,
        MediaStatus.AVAILABLE,
      ]),
      MediaStatus.AVAILABLE
    );
    assert.equal(
      of(MediaRequestStatus.COMPLETED, [MediaStatus.DELETED]),
      MediaStatus.DELETED
    );
    assert.equal(
      of(MediaRequestStatus.COMPLETED, [undefined]),
      MediaStatus.AVAILABLE
    );
  });
});

describe('an album’s downloads', () => {
  const item = (foreignAlbumId?: string) =>
    ({
      downloadId: foreignAlbumId ?? 'none',
      album: foreignAlbumId ? { id: 1, title: 'x', foreignAlbumId } : undefined,
    }) as DownloadingItem;

  it('are the artist’s downloads for that album, or those albums', () => {
    const all = [item('a'), item('b'), item()];
    assert.deepEqual(
      albumDownloads(all, 'a').map((d) => d.downloadId),
      ['a']
    );
    assert.deepEqual(
      albumDownloads(all, ['a', 'b']).map((d) => d.downloadId),
      ['a', 'b']
    );
    assert.deepEqual(albumDownloads(undefined, 'a'), []);
  });
});
