import { useEffect, useRef } from 'react';

/**
 * A title whose state changed here: requested, say. Rows loaded page by page
 * (useSWRInfinite) are left out when SWR is told to refresh every key that
 * matches, so they listen for this instead and reload the pages that hold it.
 */
export interface ChangedTitle {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
}

const EVENT = 'seerr:title-changed';

export const announceTitleChanged = (title: ChangedTitle): void => {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent<ChangedTitle>(EVENT, { detail: title }));
};

/** Whether a page of results holds the title. */
export const pageHolds = (page: unknown, title: ChangedTitle): boolean => {
  const results = (page as { results?: unknown } | null | undefined)?.results;
  return (
    Array.isArray(results) &&
    results.some((result: { id?: number; mediaType?: string }) => {
      if (result?.id !== title.tmdbId) {
        return false;
      }
      // Rows of one kind (a films row, say) may not say which kind they are.
      return !result.mediaType || result.mediaType === title.mediaType;
    })
  );
};

/** Calls back with each title that changes while the component is shown. */
const useTitleChanged = (onChange: (title: ChangedTitle) => void): void => {
  const latest = useRef(onChange);

  useEffect(() => {
    latest.current = onChange;
  });

  useEffect(() => {
    const listener = (event: Event) => {
      const title = (event as CustomEvent<ChangedTitle>).detail;
      if (title) {
        latest.current(title);
      }
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
};

export default useTitleChanged;
