/*
 * Getting things ready before they are scrolled to. Cards, their pictures and
 * the rows of the request list start loading once they are "near the screen"
 * rather than once they are on it: a phone (Safari above all) only starts a
 * lazily loaded picture when it is about to be drawn, so scrolling showed
 * blank cards that filled in as you looked at them.
 */

/**
 * How far ahead of the screen, down a page: about two screens above and
 * below. A page of cards loads ahead by as much (see useVerticalScroll).
 */
export const SCREENS_AHEAD = '200% 0px';

/**
 * How far ahead along a row of cards, measured against the row itself: about
 * a row's width either side, two or three cards on a phone. Only for a row
 * that is itself near the screen.
 */
export const ROW_AHEAD = '0px 100%';

/** Whether something is near the screen, and whether it was on it then. */
export interface Nearness {
  near: boolean;
  /**
   * On the screen itself when it came near: the first cards of a page, or
   * ones scrolled to faster than they could load. Their pictures are fetched
   * before others.
   */
  onScreen: boolean;
}

/** Whether a box (from getBoundingClientRect) shows on a screen this size. */
export const isOnScreen = (
  box: { top: number; bottom: number; left: number; right: number },
  width: number,
  height: number
) => box.bottom > 0 && box.top < height && box.right > 0 && box.left < width;

/**
 * How a picture inside something near the screen (or not yet) loads. One
 * the page needs at once (`urgent`) always loads straight away and first.
 * Otherwise, near the screen it loads now, and first if it was on the
 * screen; not yet near, it is left to the browser to load as it scrolls
 * into view. A picture outside any such card keeps what it asked for.
 */
export const pictureLoading = (
  nearness: Nearness | null,
  {
    urgent = false,
    loading,
  }: { urgent?: boolean; loading?: 'eager' | 'lazy' } = {}
): { loading?: 'eager' | 'lazy'; fetchPriority?: 'high' } => {
  if (urgent) {
    return { loading: 'eager', fetchPriority: 'high' };
  }
  if (!nearness || loading === 'eager') {
    return { loading };
  }
  if (!nearness.near) {
    return { loading: 'lazy' };
  }
  return nearness.onScreen
    ? { loading: 'eager', fetchPriority: 'high' }
    : { loading: 'eager' };
};
