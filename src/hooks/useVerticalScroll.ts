import throttle from 'lodash/throttle';
import { useEffect, useMemo, useRef, useState } from 'react';

const IS_SCROLLING_CHECK_THROTTLE = 200;

/**
 * How far ahead of the bottom the next page is asked for, in screen
 * heights: far enough that a fast scroll does not reach the end before that
 * page, and its posters, have arrived.
 */
const BUFFER_SCREENS = 2;

/** How often the position is checked while scrolling. */
const CHECK_EVERY_MS = 100;

/**
 * useVerticalScroll is a custom hook to handle infinite scrolling
 *
 * @param callback Callback is executed when page reaches bottom
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

  // The latest callback and state, for a check that outlives renders.
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
    // Checked while scrolling, not only once it stops: a debounce here meant
    // a steady scroll never asked for the next page until it paused.
    return throttle(runCallback, CHECK_EVERY_MS);
  }, []);

  // After every render: a page that has just loaded may still be short of
  // the screen.
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
