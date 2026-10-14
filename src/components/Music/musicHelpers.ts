import type { MusicAlbumResult } from '@server/models/Music';

/*
 * Small helpers the music pages share: where pictures are, and how albums
 * are grouped on an artist's page.
 */

/** Hosts the image proxy fetches music pictures from, by proxy source. */
const PROXIED = [
  ['caa', 'https://coverartarchive.org/'],
  ['fanart', 'https://assets.fanart.tv/'],
  ['tadb', 'https://r2.theaudiodb.com/'],
] as const;

/**
 * A cover or picture's address: through the image proxy when the server
 * caches images (Settings → General), else straight from its host.
 */
export const musicImageSrc = (url: string, cacheImages: boolean): string => {
  if (!cacheImages) {
    return url;
  }
  for (const [source, host] of PROXIED) {
    if (url.startsWith(host)) {
      return `/imageproxy/${source}/${url.slice(host.length)}`;
    }
  }
  return url;
};

/** A picture of an artist: the server finds one, or answers 404. */
export const artistImageUrl = (
  artistId: string,
  kind: 'photo' | 'backdrop' = 'photo'
): string =>
  `/api/v1/music/artist/${artistId}/image${
    kind === 'backdrop' ? '?kind=backdrop' : ''
  }`;

/** The year of a date as MusicBrainz gives it ("2004", "2004-03"...). */
export const yearOf = (date?: string): string | undefined =>
  date && /^\d{4}/.test(date) ? date.slice(0, 4) : undefined;

export type AlbumGroup = 'albums' | 'eps' | 'singles' | 'other';

export const ALBUM_GROUPS: AlbumGroup[] = ['albums', 'eps', 'singles', 'other'];

/**
 * Where an album goes on its artist's page: studio albums, EPs and singles
 * by themselves; live albums, compilations, soundtracks, remixes and
 * anything else under Other.
 */
export const albumGroup = (album: MusicAlbumResult): AlbumGroup => {
  if (album.secondaryTypes.length) {
    return 'other';
  }
  switch (album.primaryType) {
    case 'Album':
      return 'albums';
    case 'EP':
      return 'eps';
    case 'Single':
      return 'singles';
    default:
      return 'other';
  }
};

/** Newest first; undated ones last. */
export const byNewest = (a: MusicAlbumResult, b: MusicAlbumResult): number =>
  (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '');

/** A track's length, as 3:07 or 1:02:45. */
export const trackLength = (ms?: number | null): string | undefined => {
  if (!ms || ms < 0) {
    return undefined;
  }
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
};
