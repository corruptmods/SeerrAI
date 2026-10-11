import { MediaStatus } from '@server/constants/media';
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
  isOwner: boolean;
  watchedSync?: boolean;
  owner: { id: number; displayName: string };
  members: { id: number; displayName: string }[];
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
    listId ? `/api/v1/list/${listId}` : null
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
