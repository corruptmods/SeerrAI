import type { ServerAlbum } from '@server/lib/music/matcher';
import type { MusicLibrary } from '@server/lib/settings';

/** A media server's music libraries as albums to place. */
export interface MusicSource {
  /**
   * A library's albums: all, or those added since a time (ms). Throws if the
   * server doesn't respond.
   */
  albums(
    library: MusicLibrary,
    options: { since?: number }
  ): Promise<ServerAlbum[]>;
  /**
   * Finds an album's folders when the listing has none, within a per-run
   * limit; true if found.
   */
  fillPaths?(album: ServerAlbum): Promise<boolean>;
}
