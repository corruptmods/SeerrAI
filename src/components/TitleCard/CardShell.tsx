import Spinner from '@app/assets/spinner.svg';
import CachedImage from '@app/components/Common/CachedImage';
import { useIsTouch } from '@app/hooks/useIsTouch';
import useNearScreen, { bothRefs, NearScreen } from '@app/hooks/useNearScreen';
import { Transition } from '@headlessui/react';
import Link from 'next/link';
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

/*
 * Shared poster card for titles, collections, albums and artists: a 2:3
 * tile with a type badge top left, status top right, and title plus actions
 * over the picture on hover, focus or tap.
 */

/** Card width in a row, or full width in a grid cell. */
export const cardWidth = (canExpand?: boolean) =>
  canExpand ? 'w-full' : 'w-36 sm:w-36 md:w-44';

/**
 * `sizes` for the card picture (see sourcesFor): cardWidth in a row; in a
 * grid, half a phone screen, capped below two of the narrowest cells.
 */
export const cardImageSizes = (canExpand?: boolean) =>
  canExpand
    ? '(max-width: 639px) 50vw, 20rem'
    : '(min-width: 768px) 11rem, 9rem';

/**
 * Card detail state and handlers: hover with a mouse, otherwise tap or Enter.
 */
export const useCardDetail = () => {
  const isTouch = useIsTouch();
  const [showDetail, setShowDetail] = useState(false);

  /*
   * On touch, mouseleave only fires when the next tap lands on a tracked
   * element; after one of this card's modals closes it doesn't, leaving two
   * cards open. So close on any press outside the card. Presses in the
   * card's portalled modals still bubble through the card in React, so they
   * count as inside.
   */
  const pressedInside = useRef(false);
  useEffect(() => {
    if (!isTouch || !showDetail) {
      return;
    }
    pressedInside.current = false;
    const onPress = () => {
      if (!pressedInside.current) {
        setShowDetail(false);
      }
      pressedInside.current = false;
    };
    document.addEventListener('pointerdown', onPress);
    return () => document.removeEventListener('pointerdown', onPress);
  }, [isTouch, showDetail]);

  return {
    showDetail,
    /** Spread on the card's outermost element. */
    cardProps: {
      onPointerDown: () => {
        pressedInside.current = true;
      },
    },
    /** Spread on the tile. */
    tileProps: {
      onMouseEnter: () => {
        if (!isTouch) {
          setShowDetail(true);
        }
      },
      onMouseLeave: () => setShowDetail(false),
      onClick: () => setShowDetail(true),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
          setShowDetail(true);
        }
      },
    },
  };
};

export type CardDetail = ReturnType<typeof useCardDetail>;

/** Placeholder for a title without a picture. */
export const NoPicture = () => (
  <CachedImage
    type="tmdb"
    className="absolute inset-0 h-full w-full"
    alt=""
    src="/images/seerr_poster_not_found_logo_top.png"
    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
    fill
  />
);

/**
 * Card outer box that tells the picture when it nears the screen so it loads
 * early: from the row's signal in a row, on its own in a grid.
 */
const NearCard = ({
  cardRef,
  testId,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  cardRef?: Ref<HTMLDivElement>;
  testId: string;
}) => {
  const { ref: nearRef, nearness } = useNearScreen();
  const ref = useMemo(() => bothRefs(cardRef, nearRef), [cardRef, nearRef]);
  return (
    <div ref={ref} data-testid={testId} {...props}>
      <NearScreen.Provider value={nearness}>{children}</NearScreen.Provider>
    </div>
  );
};

interface CardShellProps {
  detail: CardDetail;
  canExpand?: boolean;
  testId: string;
  cardRef?: Ref<HTMLDivElement>;
  /** Dialogs rendered inside the card so presses in them count as inside. */
  modals?: ReactNode;
  image: ReactNode;
  /** Top-left type badge: Movie, Series, Album... */
  badge: { label: string; className: string };
  /** Top-right status and markers. */
  indicators?: ReactNode;
  /** Controls under the indicators, shown with the details. */
  controls?: ReactNode;
  updating?: boolean;
  showOverlay: boolean;
  href: string;
  /** Called when the card's link is followed, before the page loads. */
  onOpen?: () => void;
  /** Shown above the title, e.g. the year. */
  overline?: string;
  title: string;
  titleTestId?: string;
  summary?: ReactNode;
  /** Reserve a row under the text for the actions. */
  roomForActions: boolean;
  actions?: ReactNode;
  /**
   * Always caption the picture with the name; music covers rarely show it the
   * way posters do.
   */
  captioned?: boolean;
}

const CardShell = ({
  detail,
  canExpand,
  testId,
  cardRef,
  modals,
  image,
  badge,
  indicators,
  controls,
  updating = false,
  showOverlay,
  href,
  onOpen,
  overline,
  title,
  titleTestId,
  summary,
  roomForActions,
  actions,
  captioned = false,
}: CardShellProps) => (
  <NearCard
    className={cardWidth(canExpand)}
    testId={testId}
    cardRef={cardRef}
    {...detail.cardProps}
  >
    {modals}
    <div
      className={`relative transform-gpu cursor-default overflow-hidden rounded-xl bg-surface bg-cover outline-none ring-1 transition duration-300 ${
        detail.showDetail
          ? 'scale-105 shadow-lg ring-gray-500'
          : 'scale-100 shadow ring-subtle'
      }`}
      style={{
        paddingBottom: '150%',
      }}
      {...detail.tileProps}
      role="link"
      tabIndex={0}
      data-seerr="title-card"
    >
      <div
        className="absolute inset-0 h-full w-full overflow-hidden"
        data-seerr="poster"
      >
        {image}
        <div className="absolute left-0 right-0 flex items-start justify-between p-2">
          <div
            className={`pointer-events-none z-40 self-start rounded-full border shadow-md ${badge.className}`}
          >
            <div className="flex h-4 items-center px-2 py-2 text-center text-xs font-medium uppercase tracking-wider text-on-media sm:h-5">
              {badge.label}
            </div>
          </div>
          {/*
            One right-hand column (markers over controls); three siblings
            under justify-between would spread unevenly.
          */}
          <div className="flex flex-col items-end gap-1">
            {/* One row, sized like StatusBadgeMini's shrink variant. */}
            <div className="pointer-events-none z-40 flex items-center gap-1">
              {indicators}
            </div>
            {controls}
          </div>
        </div>
        {captioned && !showOverlay && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 z-30 px-2 pb-2 pt-8 text-on-media"
            style={{
              background:
                'linear-gradient(180deg, rgb(var(--card-scrim) / 0) 0%, rgb(var(--card-scrim) / 0.85) 70%)',
            }}
          >
            <div className="truncate text-sm font-semibold leading-tight">
              {title}
            </div>
            {summary && (
              <div className="truncate text-xs opacity-80">{summary}</div>
            )}
          </div>
        )}
        <Transition
          as={Fragment}
          show={updating}
          enter="transition-opacity ease-in-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="transition-opacity ease-in-out duration-300"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="absolute inset-0 z-40 flex items-center justify-center rounded-xl bg-[rgb(var(--media-scrim-raised)/0.75)] text-on-media">
            <Spinner className="h-10 w-10" />
          </div>
        </Transition>

        <Transition
          as={Fragment}
          show={showOverlay}
          enter="transition-opacity"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="transition-opacity"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="absolute inset-0 overflow-hidden rounded-xl">
            <Link
              href={href}
              onClick={onOpen}
              className="absolute inset-0 h-full w-full cursor-pointer overflow-hidden text-left"
              style={{
                background:
                  'linear-gradient(180deg, rgb(var(--card-scrim) / 0.4) 0%, rgb(var(--card-scrim) / 0.9) 100%)',
              }}
            >
              <div className="flex h-full w-full items-end">
                <div
                  className={`px-2 text-on-media ${roomForActions ? 'pb-11' : 'pb-2'}`}
                >
                  {overline && (
                    <div className="text-sm font-medium">{overline}</div>
                  )}

                  <h1
                    className="whitespace-normal text-xl font-bold leading-tight"
                    style={{
                      WebkitLineClamp: 3,
                      display: '-webkit-box',
                      overflow: 'hidden',
                      WebkitBoxOrient: 'vertical',
                      wordBreak: 'break-word',
                    }}
                    data-testid={titleTestId}
                  >
                    {title}
                  </h1>
                  <div
                    className="whitespace-normal text-xs"
                    style={{
                      WebkitLineClamp: roomForActions ? 3 : 5,
                      display: '-webkit-box',
                      overflow: 'hidden',
                      WebkitBoxOrient: 'vertical',
                      wordBreak: 'break-word',
                    }}
                  >
                    {summary}
                  </div>
                </div>
              </div>
            </Link>

            <div className="absolute bottom-0 left-0 right-0 flex items-center space-x-1 px-2 py-2">
              {actions}
            </div>
          </div>
        </Transition>
      </div>
    </div>
  </NearCard>
);

export default CardShell;
