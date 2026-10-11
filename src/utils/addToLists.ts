import { MARKERS_KEY } from '@app/hooks/useMediaMarkers';
import axios from 'axios';
import type { ScopedMutator } from 'swr';

/**
 * Adds a title to several lists at once, used when requesting.
 *
 * Failures are swallowed deliberately: the request itself has already
 * succeeded by this point, and a list that could not be updated should not
 * make the request look like it failed. Returns how many landed.
 *
 * Takes the mutator from `useSWRConfig` rather than importing `mutate` from
 * swr directly — the app supplies a custom cache provider, and the imported
 * global mutate addresses swr's default cache instead, so it silently does
 * nothing here.
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
      // Reported through the count, not as a request failure.
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
