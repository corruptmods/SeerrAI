import {
  cameBack,
  readPageState,
  savePageState,
  type PageState,
} from '@app/utils/pageReturn';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useRef } from 'react';

/** Input that means the person has taken over scrolling. */
const TAKEOVER_EVENTS = ['wheel', 'touchstart', 'keydown', 'mousedown'];

/**
 * Brings a page back where it was left when it is returned to (back, forward,
 * a reload or the installed app resuming). Returns the pages to load again;
 * once `isReady` says the page holds them, scrolls to where it was. Next does
 * this itself while the data is still in memory, and then this changes
 * nothing. Saves the scroll and `pages` when the page is left or hidden.
 */
const usePageReturn = (
  name: string,
  {
    pages,
    isReady,
  }: {
    /** Pages of results loaded now. */
    pages?: number;
    /** Whether the page has what was on screen: `wanted` pages, if any. */
    isReady: (wanted: number | undefined) => boolean;
  }
): number | undefined => {
  const router = useRouter();
  const key = `${name}:${router.asPath.split('#')[0]}`;
  const saved = useMemo<PageState | undefined>(
    () => (cameBack() ? readPageState(key) : undefined),
    [key]
  );

  // The scroll still to put back, until done or the person scrolls.
  const pending = useRef<number | undefined>(undefined);
  useEffect(() => {
    pending.current = saved && saved.y > 0 ? saved.y : undefined;
    if (pending.current === undefined) {
      return;
    }
    const takeOver = () => {
      pending.current = undefined;
    };
    TAKEOVER_EVENTS.forEach((type) =>
      window.addEventListener(type, takeOver, { passive: true, once: true })
    );
    return () =>
      TAKEOVER_EVENTS.forEach((type) =>
        window.removeEventListener(type, takeOver)
      );
  }, [saved]);

  // Checked after every render: pages arrive over several.
  useEffect(() => {
    const y = pending.current;
    if (y === undefined || !isReady(saved?.pages)) {
      return;
    }
    // After layout, so the restored pages have their height.
    const frame = requestAnimationFrame(() => {
      if (pending.current !== y) {
        return;
      }
      pending.current = undefined;
      if (Math.abs(window.scrollY - y) > 1) {
        window.scrollTo({ top: y });
      }
    });
    return () => cancelAnimationFrame(frame);
  });

  const latestPages = useRef(pages);
  latestPages.current = pages;
  useEffect(() => {
    const save = () => {
      // Left before it was back in place: keep where it was.
      if (pending.current !== undefined) {
        return;
      }
      savePageState(key, {
        y: Math.max(0, Math.round(window.scrollY)),
        ...(latestPages.current && { pages: latestPages.current }),
      });
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        save();
      }
    };
    router.events.on('routeChangeStart', save);
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      router.events.off('routeChangeStart', save);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [key, router.events]);

  return saved?.pages;
};

export default usePageReturn;
