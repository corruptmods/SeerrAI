/**
 * Which of the fader's images are in the page: the one showing, the one
 * fading out and the one coming next. Mounting every one made the browser
 * download them all at once, twenty large backdrops on the sign-in page
 * before anyone had seen the second. Nothing fades out before the first
 * change, so until then the one before the first is left out too.
 */
export const mountedImages = (
  activeIndex: number,
  count: number,
  rotated: boolean
): Set<number> => {
  const total = Math.max(count, 1);
  const mounted = new Set([activeIndex, (activeIndex + 1) % total]);
  if (rotated) {
    mounted.add((activeIndex - 1 + total) % total);
  }
  return mounted;
};
