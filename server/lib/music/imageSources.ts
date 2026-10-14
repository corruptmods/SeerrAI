import { COVER_ART_ARCHIVE_URL } from '@server/api/coverartarchive';

/*
 * Where music's pictures come from, and the only paths the image proxy
 * fetches there: album covers from the Cover Art Archive, pictures of
 * artists from fanart.tv and TheAudioDB.
 */

/** Where each music picture source's images are fetched from. */
export const MUSIC_IMAGE_ORIGINS = {
  caa: COVER_ART_ARCHIVE_URL,
  fanart: 'https://assets.fanart.tv',
  tadb: 'https://r2.theaudiodb.com',
} as const;

export type MusicImageSource = keyof typeof MUSIC_IMAGE_ORIGINS;

/** fanart.tv's music pictures: /fanart/music/<artist>/<kind>/<file>. */
export const FANART_PATH =
  /^\/fanart\/music\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-z]+\/[\w.-]+\.(?:jpe?g|png)$/i;

/** TheAudioDB's pictures: /images/media/<artist|album>/<kind>/<file>. */
export const TADB_PATH =
  /^\/images\/media\/(?:artist|album)\/[a-z]+\/[\w.-]+\.(?:jpe?g|png)$/i;

/** A picture as the image proxy serves it: a source and a path there. */
export interface MusicImage {
  source: MusicImageSource;
  path: string;
}

export interface ArtistImages {
  /** A picture of the artist, for cards and their page. */
  photo: MusicImage | null;
  /** A wide one, for behind their page. */
  backdrop: MusicImage | null;
}

/** A picture's address as the proxy takes it, or null for any other. */
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
    // Not an address.
  }
  return null;
};
