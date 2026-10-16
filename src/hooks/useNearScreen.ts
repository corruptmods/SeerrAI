import type { Nearness } from '@app/utils/nearScreen';
import { isOnScreen, ROW_AHEAD, SCREENS_AHEAD } from '@app/utils/nearScreen';
import type { Ref } from 'react';
import { createContext, useContext, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { useSWRConfig } from 'swr';

/**
 * A row of cards (see Slider): the box it scrolls in, which its cards are
 * measured against, and whether the row itself is near the screen yet.
 */
export const NearRow = createContext<{
  root: Element | null;
  near: boolean;
} | null>(null);

/**
 * Whether what is inside is near the screen, for anything in it that loads:
 * set by a card's place in a row, by a card, or by a request's row. Pictures
 * inside follow it (see CachedImage).
 */
export const NearScreen = createContext<Nearness | null>(null);

const NOT_NEAR: Nearness = { near: false, onScreen: false };

/**
 * Watches one element: near once it comes within SCREENS_AHEAD of the
 * screen, or, in a row of cards, once the row is near and the element is
 * within ROW_AHEAD along it. Once near it stays so, and is no longer
 * watched. Elements watched the same way share one observer.
 */
export const useNearObserver = ({ skip = false } = {}) => {
  const row = useContext(NearRow);
  const [nearness, setNearness] = useState<Nearness>(NOT_NEAR);
  const { ref } = useInView({
    skip: skip || nearness.near || (!!row && !(row.near && row.root !== null)),
    root: row?.root ?? undefined,
    rootMargin: row ? ROW_AHEAD : SCREENS_AHEAD,
    // Without an observer (a very old browser), everything loads at once.
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

/**
 * Whether an element is near the screen: what the card or row it sits in
 * already knows (`ref` then need not be attached), or else watched itself.
 */
const useNearScreen = () => {
  const outer = useContext(NearScreen);
  const own = useNearObserver({ skip: outer !== null });
  return outer ? { ref: own.ref, nearness: outer, ...outer } : own;
};

/**
 * The address of what a card shows, to load once the card is near the
 * screen. One already loaded, as on going back to a page, is used at once:
 * waiting to be told the card is near held up cards already on the screen.
 */
export const useLoadWhenNear = (url: string, near: boolean) => {
  const { cache } = useSWRConfig();
  return near || cache.get(url)?.data !== undefined ? url : null;
};

/** One callback ref that sets each of several. */
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
