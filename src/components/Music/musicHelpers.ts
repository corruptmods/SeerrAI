import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import type { MusicAlbumResult } from '@server/models/Music';

/** Hosts the image proxy fetches music pictures from, by proxy source. */
const PROXIED = [
  ['caa', 'https://coverartarchive.org/'],
  ['fanart', 'https://assets.fanart.tv/'],
  ['tadb', 'https://r2.theaudiodb.com/'],
] as const;

/** The server's artist-picture URL (see artistImageUrl). */
const ARTIST_IMAGE =
  /^\/api\/v1\/music\/artist\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/image(\?kind=backdrop)?$/;

/**
 * A picture's URL: through the image proxy when the server caches images
 * (Settings → General), else direct. Artist pictures have their own proxy
 * path; uncached, the server redirects to the picture's host.
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
  const artist = ARTIST_IMAGE.exec(url);
  if (artist) {
    return `/imageproxy/artist/${artist[1]}${artist[2] ? '/backdrop' : ''}`;
  }
  return url;
};

/** A small album cover by release-group id. */
export const albumCoverUrl = (albumMbid: string, cacheImages: boolean) =>
  musicImageSrc(
    `https://coverartarchive.org/release-group/${albumMbid}/front-250`,
    cacheImages
  );

/** An artist picture URL; the server finds one or answers 404. */
export const artistImageUrl = (
  artistId: string,
  kind: 'photo' | 'backdrop' = 'photo'
): string =>
  `/api/v1/music/artist/${artistId}/image${
    kind === 'backdrop' ? '?kind=backdrop' : ''
  }`;

/** The year of a MusicBrainz date ("2004", "2004-03"...). */
export const yearOf = (date?: string): string | undefined =>
  date && /^\d{4}/.test(date) ? date.slice(0, 4) : undefined;

export type AlbumGroup = 'albums' | 'eps' | 'singles' | 'other';

export const ALBUM_GROUPS: AlbumGroup[] = ['albums', 'eps', 'singles', 'other'];

/**
 * An album's group on its artist's page: albums, EPs and singles; anything
 * with a secondary type (live, compilation, soundtrack...) under Other.
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

/** The card's corner label by primary type alone: album, EP, single, release. */
export const albumKind = (
  album: Pick<MusicAlbumResult, 'primaryType'>
): 'album' | 'ep' | 'single' | 'release' => {
  switch (album.primaryType) {
    case 'Album':
      return 'album';
    case 'EP':
      return 'ep';
    case 'Single':
      return 'single';
    default:
      return 'release';
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

/** A Lidarr metadata profile's allowed release types, in Lidarr's names. */
export interface AlbumKinds {
  primaryTypes: string[];
  secondaryTypes: string[];
}

/**
 * Whether a Lidarr metadata profile allows an album, as Lidarr decides: its
 * primary type and every secondary type ("Studio" means none). Sets the
 * request window's initial ticks.
 */
export const allowedByProfile = (
  album: Pick<MusicAlbumResult, 'primaryType' | 'secondaryTypes'>,
  kinds: AlbumKinds
): boolean => {
  const has = (list: string[], name: string) =>
    list.some((kind) => kind.toLowerCase() === name.toLowerCase());
  if (!album.primaryType || !has(kinds.primaryTypes, album.primaryType)) {
    return false;
  }
  return album.secondaryTypes.length
    ? album.secondaryTypes.every((kind) => has(kinds.secondaryTypes, kind))
    : has(kinds.secondaryTypes, 'Studio');
};

/** Whether it can still be requested: not here, not in progress. */
export const requestable = (status?: MediaStatus): boolean =>
  !status ||
  status === MediaStatus.UNKNOWN ||
  status === MediaStatus.DELETED ||
  // Partly here (some songs, or part in Lidarr): the rest is requestable.
  status === MediaStatus.PARTIALLY_AVAILABLE;

/**
 * A music request's progress as a media status for its badge: pending,
 * processing, or as available as its albums. The artist's own status
 * doesn't count.
 */
export const musicRequestStatus = (request: {
  status: MediaRequestStatus;
  albums?: { albumStatus?: MediaStatus }[];
}): MediaStatus => {
  const albums = (request.albums ?? []).map((album) => album.albumStatus);
  const here = (status?: MediaStatus) =>
    status === MediaStatus.AVAILABLE ||
    status === MediaStatus.PARTIALLY_AVAILABLE;

  if (request.status === MediaRequestStatus.PENDING) {
    return MediaStatus.PENDING;
  }
  if (
    albums.length &&
    albums.every((status) => status === MediaStatus.DELETED)
  ) {
    return MediaStatus.DELETED;
  }
  if (
    albums.length &&
    albums.every((status) => status === MediaStatus.AVAILABLE)
  ) {
    return MediaStatus.AVAILABLE;
  }
  if (albums.some(here)) {
    return MediaStatus.PARTIALLY_AVAILABLE;
  }
  return request.status === MediaRequestStatus.COMPLETED
    ? MediaStatus.AVAILABLE
    : MediaStatus.PROCESSING;
};

/** The artist's downloads for these albums (MusicBrainz ids). */
export const albumDownloads = (
  downloads: DownloadingItem[] | undefined,
  albumMbids: string | string[]
): DownloadingItem[] => {
  const wanted = new Set(Array.isArray(albumMbids) ? albumMbids : [albumMbids]);
  return (downloads ?? []).filter(
    (item) => !!item.album && wanted.has(item.album.foreignAlbumId)
  );
};

/** Downloads carrying any of these songs, taken from their albums. */
export const songDownloads = (
  downloads: DownloadingItem[] | undefined,
  recordingMbids: string[]
): DownloadingItem[] => {
  const wanted = new Set(recordingMbids);
  return (downloads ?? []).filter((item) =>
    (item.songs ?? []).some((id) => wanted.has(id))
  );
};

/** A song's display name: "Song (radio edit)", or just "Song". */
export const songName = (title: string, version?: string | null): string =>
  version ? `${title} (${version})` : title;
