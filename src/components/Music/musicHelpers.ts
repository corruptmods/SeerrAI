import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';
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

/** The server's address for a picture of an artist (see artistImageUrl). */
const ARTIST_IMAGE =
  /^\/api\/v1\/music\/artist\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/image(\?kind=backdrop)?$/;

/**
 * A cover or picture's address: through the image proxy when the server
 * caches images (Settings → General), else straight from its host. A
 * picture of an artist has an address of its own at the proxy, kept like
 * any other picture; without caching, the server sends the browser to the
 * picture's host.
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

/**
 * What a card calls an album in its corner, as films' say Movie: an album,
 * an EP or a single by its primary type, live albums and compilations
 * included; a broadcast or anything else, a release.
 */
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

/** The kinds of release a Lidarr metadata profile lists, as Lidarr names them. */
export interface AlbumKinds {
  primaryTypes: string[];
  secondaryTypes: string[];
}

/**
 * Whether a Lidarr metadata profile lists an album, as Lidarr decides it:
 * its primary type allowed, and every secondary type too ("Studio" stands
 * for an album with none). What the request window ticks to begin with.
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

/** An album that can still be asked for: not here, and not on its way. */
export const requestable = (status?: MediaStatus): boolean =>
  !status ||
  status === MediaStatus.UNKNOWN ||
  status === MediaStatus.DELETED ||
  // The rest of it: songs taken from it, or what Lidarr has of it.
  status === MediaStatus.PARTIALLY_AVAILABLE;

/**
 * How far along a music request is, as a title's status, for its badge:
 * waiting for approval, on its way, or here as far as its albums are. An
 * artist being here says nothing about the albums one request asked for.
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

/**
 * Of an artist's downloads, those for these albums (by their MusicBrainz
 * ids): an album's page, card or request shows its own.
 */
export const albumDownloads = (
  downloads: DownloadingItem[] | undefined,
  albumMbids: string | string[]
): DownloadingItem[] => {
  const wanted = new Set(Array.isArray(albumMbids) ? albumMbids : [albumMbids]);
  return (downloads ?? []).filter(
    (item) => !!item.album && wanted.has(item.album.foreignAlbumId)
  );
};

/** A song as it is named: "Song (radio edit)", or just "Song". */
export const songName = (title: string, version?: string | null): string =>
  version ? `${title} (${version})` : title;
