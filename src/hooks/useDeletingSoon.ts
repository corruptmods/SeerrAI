import useFeature from '@app/hooks/useFeature';
import axios from 'axios';
import useSWR from 'swr';

export interface DeletingItem {
  mediaId: number | null;
  tmdbId: number;
  mediaType: string;
  deleteAt: string;
  /** Each follows the switches of the server(s) about to delete the title. */
  showBadge: boolean;
  showInRow: boolean;
  canKeep: boolean;
}

interface DeletingResponse {
  enabled: boolean;
  items: DeletingItem[];
}

export const DELETING_KEY = '/api/v1/maintainerr/deleting';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until a deletion; 0 once it is due. */
export const daysUntil = (deleteAt: Date): number =>
  Math.max(0, Math.ceil((deleteAt.getTime() - Date.now()) / DAY_MS));

/**
 * What Maintainerr is about to delete. One shared request however many
 * posters ask, as with the list markers.
 */
export const useDeletingSoon = () => {
  // Turned off: nothing asked for, so no row, badge or Keep button.
  const on = useFeature('deletingSoon');
  const { data, mutate } = useSWR<DeletingResponse>(on ? DELETING_KEY : null, {
    revalidateOnFocus: false,
    refreshInterval: 15 * 60 * 1000,
  });

  const items = data?.items ?? [];
  const byKey = new Map(
    items.map((item) => [`${item.mediaType}:${item.tmdbId}`, item])
  );

  return {
    /** The titles for the home page row. */
    rowItems: items.filter((item) => item.showInRow),
    find: (tmdbId: number, mediaType: string): DeletingItem | undefined =>
      byKey.get(`${mediaType}:${tmdbId}`),
    keep: async (tmdbId: number, mediaType: string) => {
      await axios.post('/api/v1/maintainerr/keep', { tmdbId, mediaType });
      await mutate();
    },
  };
};

export default useDeletingSoon;
