import { refreshIntervalHelper } from '@app/utils/refreshIntervalHelper';
import { useEffect, useRef } from 'react';
import useSWR from 'swr';

/**
 * A title page's details (movie, series, collection). A page loaded from the
 * server arrives with them (`initial`): they're shown without being fetched
 * again, and kept for coming Back. Tapped through, the page opens at once and
 * fetches them here, once.
 */
const useTitleDetails = <T>(
  key: string,
  initial: T | undefined,
  watch: Parameters<typeof refreshIntervalHelper<T>>[0]
) => {
  const result = useSWR<T>(key, {
    fallbackData: initial,
    revalidateOnMount: initial === undefined,
    refreshInterval: refreshIntervalHelper<T>(watch, initial),
  });

  // Into the cache, which Back reads: it brings the page no details.
  const { mutate } = result;
  const seeded = useRef(false);
  useEffect(() => {
    if (initial !== undefined && !seeded.current) {
      seeded.current = true;
      void mutate(initial, { revalidate: false });
    }
  }, [initial, mutate]);

  return result;
};

export default useTitleDetails;
