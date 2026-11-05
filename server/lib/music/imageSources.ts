import { COVER_ART_ARCHIVE_URL } from '@server/api/coverartarchive';

/*
 * Music image sources and the only paths the image proxy fetches from them:
 * covers from the Cover Art Archive, artist images from fanart.tv and
 * TheAudioDB.
 */

/** Origin each music image source is fetched from. */
export const MUSIC_IMAGE_ORIGINS = {
  caa: COVER_ART_ARCHIVE_URL,
  fanart: 'https://assets.fanart.tv',
  tadb: 'https://r2.theaudiodb.com',
} as const;

export type MusicImageSource = keyof typeof MUSIC_IMAGE_ORIGINS;

/**
 * Extra hosts each source may redirect to. The Cover Art Archive serves
 * covers from archive.org subdomains.
 */
export const MUSIC_IMAGE_REDIRECT_HOSTS: Record<
  MusicImageSource,
  readonly string[]
> = {
  caa: ['archive.org'],
  fanart: [],
  tadb: [],
};

const DAY_S = 24 * 60 * 60;

/**
 * Cache time per source, ignoring upstream headers (the archive's describe
 * archive.org's copy, not the cover). fanart.tv and TheAudioDB use a new
 * file name per image, so a year like TMDB posters. A Cover Art Archive URL
 * can get a new cover at the same address, so it's revalidated monthly.
 */
export const MUSIC_IMAGE_KEPT_S: Record<MusicImageSource, number> = {
  caa: 30 * DAY_S,
  fanart: 365 * DAY_S,
  tadb: 365 * DAY_S,
};

/**
 * Sources whose URL stays the same when the image changes, so browsers must
 * revalidate them once expired.
 */
export const MUSIC_IMAGE_CHANGEABLE: Record<MusicImageSource, boolean> = {
  caa: true,
  fanart: false,
  tadb: false,
};

/**
 * How long a missing cover is remembered, so pages of coverless albums don't
 * re-ask the archive every few minutes. A later cover shows within this.
 */
export const MUSIC_IMAGE_MISSING_MS = 6 * 60 * 60 * 1000;

/** fanart.tv's music pictures: /fanart/music/<artist>/<kind>/<file>. */
export const FANART_PATH =
  /^\/fanart\/music\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-z]+\/[\w.-]+\.(?:jpe?g|png)$/i;

/** TheAudioDB's pictures: /images/media/<artist|album>/<kind>/<file>. */
export const TADB_PATH =
  /^\/images\/media\/(?:artist|album)\/[a-z]+\/[\w.-]+\.(?:jpe?g|png)$/i;

/** An image the proxy serves: a source and a path on it. */
export interface MusicImage {
  source: MusicImageSource;
  path: string;
}

export interface ArtistImages {
  /** Artist photo for cards and the artist page. */
  photo: MusicImage | null;
  /** Wide image behind the artist page. */
  backdrop: MusicImage | null;
}

/** Parses an allowed image URL for the proxy; null for any other. */
export const musicImageFrom = (
  address: string | null | undefined
): MusicImage | null => {
  if (!address) {
    return null;
  }
  try {
    const url = new URL(address);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      url.pathname.includes('..')
    ) {
      return null;
    }
    if (host === 'assets.fanart.tv' && FANART_PATH.test(url.pathname)) {
      return { source: 'fanart', path: url.pathname };
    }
    if (
      (host === 'theaudiodb.com' || host.endsWith('.theaudiodb.com')) &&
      TADB_PATH.test(url.pathname)
    ) {
      return { source: 'tadb', path: url.pathname };
    }
  } catch {
    // Invalid URL.
  }
  return null;
};
