import Spinner from '@app/assets/spinner.svg';
import CachedImage from '@app/components/Common/CachedImage';
import { useIsTouch } from '@app/hooks/useIsTouch';
import { Transition } from '@headlessui/react';
import Link from 'next/link';
import type { ReactNode, Ref } from 'react';
import { Fragment, useEffect, useRef, useState } from 'react';

/*
 * The shape every poster card shares: films, series and collections
 * (TitleCard), and albums and artists. A 2:3 tile with what it is at the
 * top left, its status at the top right, and on hover, focus or a tap its
 * title over the picture with the card's actions beneath.
 */

/** The width a card takes in a row of cards, or its grid cell. */
export const cardWidth = (canExpand?: boolean) =>
  canExpand ? 'w-full' : 'w-36 sm:w-36 md:w-44';

/**
 * How wide a card's picture is drawn, for a picture offered in several
 * widths (see sourcesFor): as cardWidth in a row; in a grid, half a phone's
 * screen, and never as wide as two of the grid's narrowest cells.
 */
export const cardImageSizes = (canExpand?: boolean) =>
  canExpand
    ? '(max-width: 639px) 50vw, 20rem'
    : '(min-width: 768px) 11rem, 9rem';

/**
 * Whether a card's details are showing, and the handlers that show and
 * hide them: on hover with a mouse, on a tap or Enter otherwise.
 */
export const useCardDetail = () => {
  const isTouch = useIsTouch();
  const [showDetail, setShowDetail] = useState(false);

  /*
   * On a touchscreen a card's details stay open until the browser reports the
   * finger "leaving" it, which it only does when the next tap lands somewhere
   * it tracked. After a modal from this card closes (add to a list, request)
   * that tap was in the modal, so the next card tapped opened alongside this
   * one. Close on any press outside the card instead. Presses inside the
   * card's own modals count as inside: they are portalled out of the card in
   * the page, but React delivers their events through the card, so this
   * card's handler sees them first.
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
    /** For the card's outermost element. */
    cardProps: {
      onPointerDown: () => {
        pressedInside.current = true;
      },
    },
    /** For the tile itself. */
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

/** What a card shows for a title with no picture, filling the tile. */
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

interface CardShellProps {
  detail: CardDetail;
  canExpand?: boolean;
  testId: string;
  cardRef?: Ref<HTMLDivElement>;
  /** The card's dialogs, kept inside it so presses in them count as inside. */
  modals?: ReactNode;
  /** The picture, filling the tile. */
  image: ReactNode;
  /** What the card is, at its top left: Movie, Series, Album... */
  badge: { label: string; className: string };
  /** Its status and markers, at its top right. */
  indicators?: ReactNode;
  /** Small controls beneath them, shown with the details. */
  controls?: ReactNode;
  updating?: boolean;
  /** Whether the title and actions show over the picture. */
  showOverlay: boolean;
  href: string;
  /** Above the title: the year. */
  overline?: string;
  title: string;
  titleTestId?: string;
  /** Beneath the title. */
  summary?: ReactNode;
  /** Whether the actions take a row beneath the text, which leaves room. */
  roomForActions: boolean;
  actions?: ReactNode;
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
  overline,
  title,
  titleTestId,
  summary,
  roomForActions,
  actions,
}: CardShellProps) => (
  <div
    className={cardWidth(canExpand)}
    data-testid={testId}
    ref={cardRef}
    {...detail.cardProps}
  >
    {modals}
    <div
      className={`relative transform-gpu cursor-default overflow-hidden rounded-xl bg-gray-800 bg-cover outline-none ring-1 transition duration-300 ${
        detail.showDetail
          ? 'scale-105 shadow-lg ring-gray-500'
          : 'scale-100 shadow ring-gray-700'
      }`}
      style={{
        paddingBottom: '150%',
      }}
      {...detail.tileProps}
      role="link"
      tabIndex={0}
    >
      <div className="absolute inset-0 h-full w-full overflow-hidden">
        {image}
        <div className="absolute left-0 right-0 flex items-start justify-between p-2">
          <div
            className={`pointer-events-none z-40 self-start rounded-full border shadow-md ${badge.className}`}
          >
            <div className="flex h-4 items-center px-2 py-2 text-center text-xs font-medium uppercase tracking-wider text-white sm:h-5">
              {badge.label}
            </div>
          </div>
          {/*
            Everything on the right sits in one column: the per-user markers
            on top, the hover controls beneath. Three siblings under
            justify-between spread unevenly across the card instead.
          */}
          <div className="flex flex-col items-end gap-1">
            {/*
              Markers and the status badge share one row and one size, so
              the top of the card reads as a single strip of indicators.
              Sized to match StatusBadgeMini's shrink variant.
            */}
            <div className="pointer-events-none z-40 flex items-center gap-1">
              {indicators}
            </div>
            {controls}
          </div>
        </div>
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
          <div className="absolute inset-0 z-40 flex items-center justify-center rounded-xl bg-gray-800/75 text-white">
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
              className="absolute inset-0 h-full w-full cursor-pointer overflow-hidden text-left"
              style={{
                background:
                  'linear-gradient(180deg, rgba(45, 55, 72, 0.4) 0%, rgba(45, 55, 72, 0.9) 100%)',
              }}
            >
              <div className="flex h-full w-full items-end">
                <div
                  className={`px-2 text-white ${roomForActions ? 'pb-11' : 'pb-2'}`}
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
  </div>
);

export default CardShell;
