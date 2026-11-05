import type { Nearness } from '@app/utils/nearScreen';
import { isOnScreen, ROW_AHEAD, SCREENS_AHEAD } from '@app/utils/nearScreen';
import type { Ref } from 'react';
import { createContext, useContext, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { useSWRConfig } from 'swr';

/** A card row (see Slider): its scroll container, and whether the row is near the screen. */
export const NearRow = createContext<{
  root: Element | null;
  near: boolean;
} | null>(null);

/**
 * Nearness for descendants, set by a row slot, a card or a request row.
 * Images inside follow it (see CachedImage).
 */
export const NearScreen = createContext<Nearness | null>(null);

const NOT_NEAR: Nearness = { near: false, onScreen: false };

/**
 * Watches an element: near within SCREENS_AHEAD, or in a row, once the row is
 * near and it is within ROW_AHEAD. Stays near once set. Same-option watchers
 * share one observer.
 */
export const useNearObserver = ({ skip = false } = {}) => {
  const row = useContext(NearRow);
  const [nearness, setNearness] = useState<Nearness>(NOT_NEAR);
  const { ref } = useInView({
    skip: skip || nearness.near || (!!row && !(row.near && row.root !== null)),
    root: row?.root ?? undefined,
    rootMargin: row ? ROW_AHEAD : SCREENS_AHEAD,
    // No IntersectionObserver: load everything.
    fallbackInView: true,
    onChange: (inView, entry) => {
      if (inView) {
        setNearness({
          near: true,
          onScreen: isOnScreen(
            entry.boundingClientRect,
            window.innerWidth,
            window.innerHeight
          ),
        });
      }
    },
  });
  return { ref, nearness, ...nearness };
};

/** Whether an element is near: from its card or row context (no `ref` needed), else observed. */
const useNearScreen = () => {
  const outer = useContext(NearScreen);
  const own = useNearObserver({ skip: outer !== null });
  return outer ? { ref: own.ref, nearness: outer, ...outer } : own;
};

/**
 * A card's data URL once near. Already-cached URLs (e.g. going back) are used
 * at once, so on-screen cards don't wait for the observer.
 */
export const useLoadWhenNear = (url: string, near: boolean) => {
  const { cache } = useSWRConfig();
  return near || cache.get(url)?.data !== undefined ? url : null;
};

/** Combines several refs into one callback ref. */
export const bothRefs =
  <T>(...refs: (Ref<T> | undefined)[]) =>
  (element: T | null) => {
    for (const ref of refs) {
      if (typeof ref === 'function') {
        ref(element);
      } else if (ref) {
        (ref as { current: T | null }).current = element;
      }
    }
  };

export default useNearScreen;
