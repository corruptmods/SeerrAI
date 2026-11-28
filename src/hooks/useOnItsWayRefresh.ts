import { MediaStatus } from '@server/constants/media';
import { useEffect, useRef } from 'react';

interface Shown {
  mediaInfo?: {
    status?: MediaStatus;
    status4k?: MediaStatus;
    downloadStatus?: unknown[];
    downloadStatus4k?: unknown[];
  };
}

/** While a title on the page is downloading. */
const DOWNLOADING_MS = 15_000;
/** While one is processing, not yet downloading. */
const ON_ITS_WAY_MS = 30_000;

/**
 * How soon a page needs reading again: a page holding a title that is
 * downloading or on its way changes as it arrives; other pages don't.
 */
export const pageRefreshMs = (page: unknown): number => {
  const results = (page as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(results)) {
    return 0;
  }
  let wait = 0;
  for (const result of results as Shown[]) {
    const info = result?.mediaInfo;
    if (!info) continue;
    if (
      (info.downloadStatus ?? []).length > 0 ||
      (info.downloadStatus4k ?? []).length > 0
    ) {
      return DOWNLOADING_MS;
    }
    if (
      info.status === MediaStatus.PROCESSING ||
      info.status4k === MediaStatus.PROCESSING
    ) {
      wait = ON_ITS_WAY_MS;
    }
  }
  return wait;
};

/**
 * Keeps a list's or row's pages of titles current while any is on its way.
 * Pages are kept while the app is open and the first is never re-read on its
 * own, so a title that was downloading when the list was first shown would
 * stay shown as downloading after it arrived. Pages holding one are read
 * again on coming back to the list, and every so often while it's shown.
 */
const useOnItsWayRefresh = <Page>(
  pages: Page[] | undefined,
  mutate: (
    data: Page[],
    opts: { revalidate: (page: Page) => boolean }
  ) => unknown
): void => {
  const fromCache = useRef(pages !== undefined);
  // The pages on screen go back to swr as they are: mutate(undefined) would
  // empty the row until the read comes back, and with a read already under
  // way when the page is shown again the row could stay empty.
  const shown = useRef(pages);
  shown.current = pages;
  const refreshMs = Math.min(
    ...(pages ?? []).map(pageRefreshMs).filter((ms) => ms > 0),
    Infinity
  );
  useEffect(() => {
    if (!Number.isFinite(refreshMs)) {
      return;
    }
    const refresh = () => {
      const current = shown.current;
      if (current && document.visibilityState === 'visible') {
        mutate(current, { revalidate: (page) => pageRefreshMs(page) > 0 });
      }
    };
    // Shown from what was kept: read now. A list just read needn't be.
    if (fromCache.current) {
      fromCache.current = false;
      refresh();
    }
    const timer = setInterval(refresh, refreshMs);
    return () => clearInterval(timer);
    // Reset only when how soon changes, not on every new page of data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMs]);
};

export default useOnItsWayRefresh;
