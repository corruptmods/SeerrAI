import { MediaStatus } from '@server/constants/media';
import type { PlaylistView } from '@server/lib/playlists/view';
import useSWR from 'swr';

export interface ListItem {
  id: number;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title?: string;
  posterPath?: string | null;
  releaseDate?: string;
  watchedAt?: string | null;
  /** When it was added to the list. */
  createdAt?: string;
  mediaInfo?: { status?: number };
  availableEpisodes?: number;
  totalEpisodes?: number;
}

/** The viewer's position in a series, from their Plex watch history. */
export interface SeriesProgress {
  state: 'not_started' | 'up_next' | 'caught_up';
  next?: { season: number; episode: number };
  remaining: number;
}

export interface ListDetailData {
  id: number;
  name: string;
  /** A watch list (films and series) or a playlist (songs). */
  kind?: 'watch' | 'music';
  /** A playlist's link and songs. */
  playlist?: PlaylistView;
  isOwner: boolean;
  /** Whether the viewer has accepted the list; the owner always has. */
  accepted: boolean;
  watchedSync?: boolean;
  /** For the owner: people on the list whose watch history cannot be read. */
  cannotCheck?: { id: number; displayName: string }[];
  owner: { id: number; displayName: string };
  members: { id: number; displayName: string; accepted: boolean }[];
  items: ListItem[];
}

/**
 * Watchable means there is something to play right now. A partially available
 * series counts — you can watch the episodes that are here.
 */
export const isWatchable = (item: ListItem): boolean =>
  item.mediaInfo?.status === MediaStatus.AVAILABLE ||
  item.mediaInfo?.status === MediaStatus.PARTIALLY_AVAILABLE;

/**
 * Loads a list and derives the three groups the page renders.
 *
 * Kept out of the component so the grouping rules — which decide what the
 * roulette may land on — can be read and tested on their own.
 */
export const useListDetail = (listId: number | string | undefined) => {
  const { data, error, mutate } = useSWR<ListDetailData>(
    listId ? `/api/v1/list/${listId}` : null,
    {
      // A playlist's songs are matched and requested in the background:
      // followed while any are still on their way to being requested.
      refreshInterval: (latest) =>
        latest?.playlist?.songs.some(
          (song) => song.state === 'matching' || song.state === 'queued'
        )
          ? 4000
          : 0,
    }
  );

  const items = data?.items ?? [];

  // Watched titles move to their own section so the list reads as what is
  // still outstanding, with the finished ones kept below rather than removed.
  const watched = items.filter((item) => item.watchedAt);
  const unwatched = items.filter(
    (item) => !item.watchedAt && isWatchable(item)
  );
  const unavailable = items.filter(
    (item) => !item.watchedAt && !isWatchable(item)
  );

  /** The roulette only offers things that can actually be played tonight. */
  const rouletteCandidates = (type: 'movie' | 'tv' | 'all') =>
    type === 'all'
      ? unwatched
      : unwatched.filter((item) => item.mediaType === type);

  return {
    data,
    error,
    mutate,
    watched,
    unwatched,
    unavailable,
    rouletteCandidates,
  };
};

export default useListDetail;
