import TitleCard from '@app/components/TitleCard';
import { NearRow, NearScreen, useNearObserver } from '@app/hooks/useNearScreen';
import globalMessages from '@app/i18n/globalMessages';
import { SCREENS_AHEAD } from '@app/utils/nearScreen';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { useSpring } from '@react-spring/web';
import debounce from 'lodash/debounce';
import type { ReactNode } from 'react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useInView } from 'react-intersection-observer';
import { useIntl } from 'react-intl';

interface SliderProps {
  sliderKey: string;
  items?: JSX.Element[];
  isLoading: boolean;
  isEmpty?: boolean;
  emptyMessage?: React.ReactNode;
  placeholder?: React.ReactNode;
}

enum Direction {
  RIGHT,
  LEFT,
}

/**
 * A card's place in the row. It tells the card inside, and its picture,
 * when it comes near the screen along the row, so the next few cards are
 * ready before they are swiped to.
 */
const Slot = ({ children }: { children: ReactNode }) => {
  const { ref, nearness } = useNearObserver();
  return (
    <div ref={ref} className="inline-block px-2 align-top">
      <NearScreen.Provider value={nearness}>{children}</NearScreen.Provider>
    </div>
  );
};

const Slider = ({
  sliderKey,
  items,
  isLoading,
  isEmpty = false,
  emptyMessage,
  placeholder = <TitleCard.Placeholder />,
}: SliderProps) => {
  const intl = useIntl();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The row's cards are measured against the box they scroll in, once the
  // row itself is near the screen.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const setContainer = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element;
    setRoot(element);
  }, []);
  const { ref: rowRef, inView: rowNear } = useInView({
    triggerOnce: true,
    rootMargin: SCREENS_AHEAD,
    fallbackInView: true,
  });
  const row = useMemo(() => ({ root, near: rowNear }), [root, rowNear]);
  const [scrollPos, setScrollPos] = useState({ isStart: true, isEnd: false });

  // The parent builds a new items array every time it renders; only how many
  // there are (and the loading placeholders) change what the arrows should
  // show. Measuring the row forces a layout, so it is done when those change,
  // not on every render.
  const itemCount = items?.length ?? 0;

  const handleScroll = useCallback(() => {
    const margin = 5;
    const scrollWidth = containerRef.current?.scrollWidth ?? 0;
    const clientWidth =
      containerRef.current?.getBoundingClientRect().width ?? 0;
    const scrollPosition = containerRef.current?.scrollLeft ?? 0;

    let next: { isStart: boolean; isEnd: boolean };
    if (itemCount === 0) {
      next = { isStart: true, isEnd: true };
    } else if (clientWidth >= scrollWidth) {
      next = { isStart: true, isEnd: true };
    } else if (scrollPosition >= scrollWidth - clientWidth - margin) {
      next = { isStart: false, isEnd: true };
    } else if (scrollPosition > margin) {
      next = { isStart: false, isEnd: false };
    } else {
      next = { isStart: true, isEnd: false };
    }

    // Keep the same object when nothing changed, so the row does not
    // re-render for nothing.
    setScrollPos((current) =>
      current.isStart === next.isStart && current.isEnd === next.isEnd
        ? current
        : next
    );
  }, [itemCount]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedScroll = useCallback(
    debounce(() => handleScroll(), 50),
    [handleScroll]
  );

  // A pending measurement must not run after the row is gone.
  useEffect(() => () => debouncedScroll.cancel(), [debouncedScroll]);

  useEffect(() => {
    const handleResize = () => {
      debouncedScroll();
    };

    window.addEventListener('resize', handleResize, { passive: true });

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [debouncedScroll]);

  // Loading adds or removes the placeholders, which changes the width too.
  useEffect(() => {
    handleScroll();
  }, [handleScroll, isLoading]);

  const onScroll = () => {
    debouncedScroll();
  };

  const [, setX] = useSpring(() => ({
    from: { x: 0 },
    to: { x: 0 },
  }));

  const slide = async (direction: Direction) => {
    const clientWidth =
      containerRef.current?.getBoundingClientRect().width ?? 0;
    const cardWidth =
      containerRef.current?.firstElementChild?.getBoundingClientRect().width ??
      0;
    const scrollPosition = containerRef.current?.scrollLeft ?? 0;
    const visibleItems = Math.floor(clientWidth / cardWidth);
    const scrollOffset = scrollPosition % cardWidth;

    if (direction === Direction.LEFT) {
      const newX = Math.max(
        scrollPosition - scrollOffset - visibleItems * cardWidth,
        0
      );
      await setX.start({
        from: { x: scrollPosition },
        to: { x: newX },
        onChange: (results) => {
          if (containerRef.current) {
            containerRef.current.scrollLeft = results.value.x;
          }
        },
        reset: true,
        config: { friction: 60, tension: 500, velocity: 20 },
      })[0];

      if (newX === 0) {
        setScrollPos({ isStart: true, isEnd: false });
      } else {
        setScrollPos({ isStart: false, isEnd: false });
      }
    } else if (direction === Direction.RIGHT) {
      const newX = Math.min(
        scrollPosition - scrollOffset + visibleItems * cardWidth,
        containerRef.current?.scrollWidth ?? 0 - clientWidth
      );
      await setX.start({
        from: { x: scrollPosition },
        to: { x: newX },
        onChange: (results) => {
          if (containerRef.current) {
            containerRef.current.scrollLeft = results.value.x;
          }
        },
        reset: true,
        config: { friction: 60, tension: 500, velocity: 20 },
      })[0];

      if (newX >= (containerRef.current?.scrollWidth ?? 0) - clientWidth) {
        setScrollPos({ isStart: false, isEnd: true });
      } else {
        setScrollPos({ isStart: false, isEnd: false });
      }
    }
  };

  return (
    <div
      className="relative"
      data-testid="media-slider"
      data-seerr="slider"
      ref={rowRef}
    >
      <div className="absolute right-0 -mt-10 flex text-muted">
        <button
          className={`${
            scrollPos.isStart ? 'text-gray-800' : 'hover:text-strong'
          }`}
          onClick={() => slide(Direction.LEFT)}
          disabled={scrollPos.isStart}
          type="button"
          aria-label={intl.formatMessage(globalMessages.previous)}
        >
          <ChevronLeftIcon className="h-6 w-6" />
        </button>
        <button
          className={`${
            scrollPos.isEnd ? 'text-gray-800' : 'hover:text-strong'
          }`}
          onClick={() => slide(Direction.RIGHT)}
          disabled={scrollPos.isEnd}
          type="button"
          aria-label={intl.formatMessage(globalMessages.next)}
        >
          <ChevronRightIcon className="h-6 w-6" />
        </button>
      </div>
      <div
        className="hide-scrollbar relative -my-2 -ml-4 -mr-4 overflow-y-auto overflow-x-scroll overscroll-x-contain whitespace-nowrap px-2 py-2"
        ref={setContainer}
        onScroll={onScroll}
      >
        <NearRow.Provider value={row}>
          {items?.map((item, index) => (
            <Slot key={`${sliderKey}-${index}`}>{item}</Slot>
          ))}
        </NearRow.Provider>
        {isLoading &&
          [...Array(10)].map((_item, i) => (
            <div
              key={`placeholder-${i}`}
              className="inline-block px-2 align-top"
            >
              {placeholder}
            </div>
          ))}
        {isEmpty && (
          <div className="mb-16 mt-16 text-center font-medium text-muted">
            {emptyMessage
              ? emptyMessage
              : intl.formatMessage(globalMessages.noresults)}
          </div>
        )}
      </div>
    </div>
  );
};

export default Slider;
