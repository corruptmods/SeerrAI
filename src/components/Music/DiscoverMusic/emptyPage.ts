/** One Music page row's load state. */
export interface MusicRowState {
  /** Done loading, whether it answered or failed. */
  loaded: boolean;
  /** Items to show (0 if it failed). */
  count: number;
}

/**
 * Admin hints for an empty Music page: turn on New and Popular Music
 * (ListenBrainz rows), or albums reaching a media server (Recently Added).
 */
export type MusicPageHint = 'listenBrainz' | 'albumsHere';

/**
 * The empty-page message when every row has loaded empty (empty rows hide
 * themselves). Null while any row loads or has items.
 *
 * `listenBrainz`: whether New and Popular Music is on, if known (admin-only);
 * its hint is given only when known to be off.
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
