/**
 * Initial pages: enough to fill a tall screen. The first shows on arrival and
 * the rest are requested then; requesting all at once shows nothing until
 * every one arrives.
 */
export const START_PAGES = 3;

interface Page {
  totalPages: number;
  totalResults: number;
}

/** A list's state from its pages: still loading initial pages, empty, or at the end. */
export const listProgress = ({
  pages,
  loadingFirst,
  size,
  titlesShown,
  shortPages,
}: {
  /** Pages so far; undefined before the first. */
  pages: Page[] | undefined;
  /** The first page is still loading. */
  loadingFirst: boolean;
  /** Pages requested. */
  size: number;
  /** Titles left after local hiding. */
  titlesShown: number;
  /** Pages may hold fewer than 20 without being last, so only the page count marks the end. */
  shortPages: boolean;
}): { starting: boolean; isEmpty: boolean; isReachingEnd: boolean } => {
  const lastPage = pages?.[pages.length - 1];
  if (!pages || !lastPage) {
    // No pages: still loading, or the first page failed (nothing more).
    const isEmpty = !loadingFirst && titlesShown === 0 && !shortPages;
    return { starting: false, isEmpty, isReachingEnd: isEmpty };
  }
  const onLastPage = pages.length >= lastPage.totalPages;
  const starting = pages.length < Math.min(START_PAGES, lastPage.totalPages);
  const isEmpty = !starting && titlesShown === 0 && (!shortPages || onLastPage);

  const isReachingEnd = shortPages
    ? isEmpty || onLastPage
    : isEmpty ||
      // Stop at the server's last page: a page can hold more than 20 (search
      // adds collections), so the counts below could wait on a page never
      // requested. A short page isn't the end: TMDB sends some mid-list.
      onLastPage ||
      lastPage.totalResults <= size * 20 ||
      lastPage.totalResults < 41;

  return { starting, isEmpty, isReachingEnd };
};
