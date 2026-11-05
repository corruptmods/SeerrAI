/** Backfill's work on a title, as its requester sees it. */
export interface BackfillStatus {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  /** Searching beyond the usual search, or downloading what it found. */
  state: 'looking' | 'downloading';
  progress?: number;
  /** The admin agent is searching for it now. */
  agent?: boolean;
}
