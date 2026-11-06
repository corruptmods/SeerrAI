import type { RefObject } from 'react';
import { useEffect } from 'react';

/**
 * Keeps a bar fixed to the bottom of the screen at the bottom. iOS can bring a
 * home-screen app back from the background laid out for a shorter screen,
 * leaving the bar partway up with the page showing below it until a reload.
 *
 * When the app is shown again or the screen changes size, a bar whose bottom
 * edge sits above the visible bottom first has the page laid out again; if it
 * is still above, it is moved down by the gap until the layout catches up. A
 * bar at the bottom, or below it (the keyboard is open), is left alone.
 */
export default function useStayAtBottom(
  ref: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    const bar = ref.current;
    if (!bar || typeof window === 'undefined') return;
    let frame = 0;

    const visibleBottom = () =>
      window.visualViewport
        ? window.visualViewport.offsetTop + window.visualViewport.height
        : window.innerHeight;
    // How far the bar sits above the visible bottom, without the shift.
    const gap = () =>
      visibleBottom() -
      (bar.getBoundingClientRect().bottom - (Number(bar.dataset.shift) || 0));
    const shift = (by: number) => {
      bar.dataset.shift = String(by);
      bar.style.transform = by ? `translateY(${by}px)` : '';
    };

    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (document.visibilityState !== 'visible') return;
        if (gap() <= 1) {
          shift(0);
          return;
        }
        // Scrolling by a pixel and back has WebKit place fixed bars again.
        const y = window.scrollY;
        window.scrollTo(window.scrollX, y + 1);
        window.scrollTo(window.scrollX, y);
        frame = requestAnimationFrame(() => {
          const left = gap();
          shift(left > 1 ? Math.round(left) : 0);
        });
      });
    };

    const onShown = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onShown);
    window.addEventListener('pageshow', check);
    window.addEventListener('resize', check);
    window.visualViewport?.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    check();

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onShown);
      window.removeEventListener('pageshow', check);
      window.removeEventListener('resize', check);
      window.visualViewport?.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
      shift(0);
    };
  }, [ref]);
}
