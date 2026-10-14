import type { ServerAlbum } from '@server/lib/music/matcher';
import type { MusicLibrary } from '@server/lib/settings';

/** A media server's music libraries, as albums to place. */
export interface MusicSource {
  /**
   * A library's albums: all of them, or those added since a time (ms).
   * Throws when the server does not answer.
   */
  albums(
    library: MusicLibrary,
    options: { since?: number }
  ): Promise<ServerAlbum[]>;
  /**
   * Finds an album's folders when the listing has none, within a limit a
   * run; true when it found them.
   */
  fillPaths?(album: ServerAlbum): Promise<boolean>;
}
