/** How one of the Music page's rows has answered. */
export interface MusicRowState {
  /** Answered, or failed: either way it is done loading. */
  loaded: boolean;
  /** What it has to show (none if it failed). */
  count: number;
}

/**
 * What would fill an empty Music page, told to admins: switching on New
 * and Popular Music (the ListenBrainz rows), and albums reaching a media
 * server (Recently Added).
 */
export type MusicPageHint = 'listenBrainz' | 'albumsHere';

/**
 * What the Music page says when none of its rows has anything. Each row
 * leaves itself out when empty, which would leave the page blank below its
 * search box. Nothing is said while a row is still loading, or once any
 * row has something to show.
 *
 * `listenBrainz` is whether New and Popular Music is on, when known (only
 * admins can read it); the hint to switch it on is only given when it is
 * known to be off.
 */
export const emptyMusicPage = (
  rows: readonly MusicRowState[],
  admin: boolean,
  listenBrainz: boolean | undefined
): { hints: MusicPageHint[] } | null => {
  if (rows.some((row) => !row.loaded || row.count > 0)) {
    return null;
  }
  if (!admin) {
    return { hints: [] };
  }
  return {
    hints:
      listenBrainz === false ? ['listenBrainz', 'albumsHere'] : ['albumsHere'],
  };
};
