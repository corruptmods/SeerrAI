import { MARKERS_KEY } from '@app/hooks/useMediaMarkers';
import axios from 'axios';
import type { ScopedMutator } from 'swr';

/**
 * Adds a title to several lists when requesting; returns how many succeeded.
 *
 * Failures are swallowed: the request already succeeded and shouldn't look
 * failed.
 *
 * Takes `mutate` from `useSWRConfig`: the app uses a custom cache provider,
 * and swr's global `mutate` targets the default cache, silently doing nothing.
 */
export const addToLists = async (
  listIds: number[],
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  mutate?: ScopedMutator
): Promise<number> => {
  let added = 0;

  for (const listId of listIds) {
    try {
      await axios.post(`/api/v1/list/${listId}/item`, { tmdbId, mediaType });
      added++;
    } catch {
      // Reflected in the count.
    }
  }

  if (added && mutate) {
    await Promise.all([
      mutate('/api/v1/list'),
      mutate(`/api/v1/list/contains?tmdbId=${tmdbId}&mediaType=${mediaType}`),
      mutate(MARKERS_KEY),
    ]);
  }

  return added;
};

export default addToLists;
