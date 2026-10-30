/** Backfill's work on a title, as the person who requested it sees it. */
export interface BackfillStatus {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  /** Looking beyond the usual search, or downloading what it found. */
  state: 'looking' | 'downloading';
  progress?: number;
  /** The admin agent (an AI) is looking for it right now. */
  agent?: boolean;
}
