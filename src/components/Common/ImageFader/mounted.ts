/**
 * Which images to mount: the one showing, the one fading out and the next.
 * Mounting all of them downloads every backdrop at once. Before the first
 * change nothing is fading out, so the previous one is left out too.
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
