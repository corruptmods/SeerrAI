/**
 * Pages a list starts with: enough to fill a tall screen, with titles below
 * to scroll to. The first is shown as soon as it arrives and the others are
 * asked for then: a list asked for all at once shows nothing until every one
 * of them is in, and they come one after another.
 */
export const START_PAGES = 3;

interface Page {
  totalPages: number;
  totalResults: number;
}

/**
 * Where a list of titles stands, from the pages it has: whether it is still
 * getting the pages it starts with, has nothing to show, or has no more to
 * get.
 */
export const listProgress = ({
  pages,
  loadingFirst,
  size,
  titlesShown,
  shortPages,
}: {
  /** The pages in so far; undefined until the first is. */
  pages: Page[] | undefined;
  /** The first page is still on its way. */
  loadingFirst: boolean;
  /** How many pages have been asked for. */
  size: number;
  /** Titles left once those hidden here are taken out. */
  titlesShown: number;
  /**
   * The server's pages can hold fewer than 20 titles without being the
   * last, so only its page count says where the list ends.
   */
  shortPages: boolean;
}): { starting: boolean; isEmpty: boolean; isReachingEnd: boolean } => {
  const lastPage = pages?.[pages.length - 1];
  if (!pages || !lastPage) {
    // Still loading, or the first page failed: then there is nothing more.
    const isEmpty = !loadingFirst && titlesShown === 0 && !shortPages;
    return { starting: false, isEmpty, isReachingEnd: isEmpty };
  }
  const onLastPage = pages.length >= lastPage.totalPages;
  const starting = pages.length < Math.min(START_PAGES, lastPage.totalPages);
  const isEmpty = !starting && titlesShown === 0 && (!shortPages || onLastPage);

  const isReachingEnd = shortPages
    ? isEmpty || onLastPage
    : isEmpty ||
      // No page past the last one the server counts is ever asked for. A
      // page can hold more than 20 (search adds collections to each), so the
      // counts below alone could leave this waiting for a page never asked.
      // Nor is a page of fewer than 20 the end: TMDB sends some short pages
      // in the middle of a list (sorted by release date, for one).
      onLastPage ||
      lastPage.totalResults <= size * 20 ||
      lastPage.totalResults < 41;

  return { starting, isEmpty, isReachingEnd };
};
