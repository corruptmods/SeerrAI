/*
 * Load cards, images and request rows when near the screen, not on it:
 * mobile Safari starts lazy images only when about to draw them, so cards
 * scrolled in blank.
 */

/** Vertical lookahead: about two screens each way (matches useVerticalScroll). */
export const SCREENS_AHEAD = '200% 0px';

/** Horizontal lookahead within a row: one row width each side. Only for rows already near. */
export const ROW_AHEAD = '0px 100%';

/** Whether something is near the screen, and whether it was on it then. */
export interface Nearness {
  near: boolean;
  /** On screen when it came near (first cards, or fast scrolls); its images load first. */
  onScreen: boolean;
}

/** Whether a getBoundingClientRect box is visible on a screen this size. */
export const isOnScreen = (
  box: { top: number; bottom: number; left: number; right: number },
  width: number,
  height: number
) => box.bottom > 0 && box.top < height && box.right > 0 && box.left < width;

/**
 * Loading behaviour for an image. `urgent` loads now and first. Otherwise:
 * near loads now (first if on screen); not near is left lazy. Outside any
 * near context it keeps its own setting.
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
