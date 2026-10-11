import TitleCard from '@app/components/TitleCard';
import globalMessages from '@app/i18n/globalMessages';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { useSpring } from '@react-spring/web';
import debounce from 'lodash/debounce';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
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

const Slider = ({
  sliderKey,
  items,
  isLoading,
  isEmpty = false,
  emptyMessage,
  placeholder = <TitleCard.Placeholder />,
}: SliderProps) => {
  const intl = useIntl();
  const containerRef = useRef<HTMLDivElement>(null);
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
    <div className="relative" data-testid="media-slider">
      <div className="absolute right-0 -mt-10 flex text-gray-400">
        <button
          className={`${
            scrollPos.isStart ? 'text-gray-800' : 'hover:text-white'
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
            scrollPos.isEnd ? 'text-gray-800' : 'hover:text-white'
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
        ref={containerRef}
        onScroll={onScroll}
      >
        {items?.map((item, index) => (
          <div
            key={`${sliderKey}-${index}`}
            className="inline-block px-2 align-top"
          >
            {item}
          </div>
        ))}
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
          <div className="mb-16 mt-16 text-center font-medium text-gray-400">
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
