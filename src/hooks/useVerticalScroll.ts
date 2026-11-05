import throttle from 'lodash/throttle';
import { useEffect, useMemo, useRef, useState } from 'react';

const IS_SCROLLING_CHECK_THROTTLE = 200;

/** Screen heights before the bottom to request the next page, so fast scrolls don't outrun it. */
const BUFFER_SCREENS = 2;

/** Scroll position check interval. */
const CHECK_EVERY_MS = 100;

/**
 * Infinite scroll.
 *
 * @param callback Called near the bottom of the page
 * @param shouldFetch Disables callback if true
 */
const useVerticalScroll = (
  callback: () => void,
  shouldFetch: boolean
): boolean => {
  const [isScrolling, setScrolling] = useState(false);
  const scrollingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  // Latest callback and state, for a check that outlives renders.
  const latest = useRef({ callback, shouldFetch });
  latest.current = { callback, shouldFetch };

  const check = useMemo(() => {
    const runCallback = () => {
      if (!latest.current.shouldFetch) {
        return;
      }
      const scrollTop = Math.max(
        window.pageYOffset,
        document.documentElement.scrollTop,
        document.body.scrollTop
      );
      if (
        window.innerHeight + scrollTop >=
        document.documentElement.offsetHeight -
          window.innerHeight * BUFFER_SCREENS
      ) {
        latest.current.callback();
      }
    };
    // Throttled, not debounced, so a steady scroll still triggers the next page.
    return throttle(runCallback, CHECK_EVERY_MS);
  }, []);

  // After every render: a freshly loaded page may not fill the screen.
  useEffect(() => {
    check();
  });

  useEffect(() => {
    const onScroll = () => {
      if (scrollingTimer.current !== undefined) {
        clearTimeout(scrollingTimer.current);
      }
      setScrolling(true);

      scrollingTimer.current = setTimeout(() => {
        setScrolling(false);
      }, IS_SCROLLING_CHECK_THROTTLE);
      check();
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', check, { passive: true });

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', check);
      check.cancel();

      if (scrollingTimer.current !== undefined) {
        clearTimeout(scrollingTimer.current);
      }
    };
  }, [check]);

  return isScrolling;
};

export default useVerticalScroll;
