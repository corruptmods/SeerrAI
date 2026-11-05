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
  /** When added to the list. */
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
  /** For the owner: members whose watch history can't be read. */
  cannotCheck?: { id: number; displayName: string }[];
  owner: { id: number; displayName: string };
  members: { id: number; displayName: string; accepted: boolean }[];
  items: ListItem[];
}

/** Whether something is playable now; a partly available series counts. */
export const isWatchable = (item: ListItem): boolean =>
  item.mediaInfo?.status === MediaStatus.AVAILABLE ||
  item.mediaInfo?.status === MediaStatus.PARTIALLY_AVAILABLE;

/**
 * Loads a list and derives the page's three groups. Separate from the
 * component so the grouping (which drives the roulette) is testable.
 */
export const useListDetail = (listId: number | string | undefined) => {
  const { data, error, mutate } = useSWR<ListDetailData>(
    listId ? `/api/v1/list/${listId}` : null,
    {
      // Songs are matched and requested in the background: poll fast while
      // any are in progress, slower while requested ones are pending.
      refreshInterval: (latest) => {
        const songs = latest?.playlist?.songs ?? [];
        if (
          songs.some(
            (song) => song.state === 'matching' || song.state === 'queued'
          )
        ) {
          return 4000;
        }
        return songs.some((song) =>
          ['requested', 'approval', 'limit'].includes(song.state)
        )
          ? 15_000
          : 0;
      },
    }
  );

  const items = data?.items ?? [];

  // Watched titles move to their own section below rather than being removed.
  const watched = items.filter((item) => item.watchedAt);
  const unwatched = items.filter(
    (item) => !item.watchedAt && isWatchable(item)
  );
  const unavailable = items.filter(
    (item) => !item.watchedAt && !isWatchable(item)
  );

  /** Roulette candidates: only playable items. */
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
