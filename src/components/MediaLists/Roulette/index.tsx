import Button from '@app/components/Common/Button';
import PosterBackground from '@app/components/Common/PosterBackground';
import { useLockBodyScroll } from '@app/hooks/useLockBodyScroll';
import defineMessages from '@app/utils/defineMessages';
import { XMarkIcon } from '@heroicons/react/24/outline';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MediaLists.Roulette', {
  spinning: 'Picking something…',
  yourpick: 'Tonight you are watching',
  spinagain: 'Spin again',
  open: 'Open',
  close: 'Close',
});

export interface RouletteItem {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title?: string;
  posterPath?: string | null;
}

interface RouletteProps {
  items: RouletteItem[];
  onClose: () => void;
}

/** Tile width plus its gap; the reel maths depends on these matching the CSS. */
const TILE_WIDTH = 120;
const TILE_GAP = 12;
const TILE_STRIDE = TILE_WIDTH + TILE_GAP;

/** How many tiles stream past before the winner. More reads as a longer spin. */
const RUNWAY = 34;
const SPIN_MS = 4200;

const Roulette = ({ items, onClose }: RouletteProps) => {
  const intl = useIntl();
  const [spinKey, setSpinKey] = useState(0);
  const [isSpinning, setSpinning] = useState(true);
  const [offset, setOffset] = useState(0);
  /*
   * The reel has to jump back to the start without animating before it can
   * travel again. With the transition always on, a second spin slid from
   * wherever it stopped to almost the same place — pressing "Spin again"
   * looked like it did nothing at all.
   */
  const [animating, setAnimating] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  /** The previous pick, so spinning again offers something else. */
  const lastWinnerRef = useRef<number | null>(null);

  // The winner is chosen up front; the reel is then built to end on it, so
  // the animation can never disagree with the result.
  const { reel, winner } = useMemo(() => {
    /*
     * Avoid handing back the title they just rejected. With a short unwatched
     * list that happened often enough that spinning again felt broken.
     */
    const choices =
      items.length > 1 && lastWinnerRef.current
        ? items.filter((item) => item.tmdbId !== lastWinnerRef.current)
        : items;

    const pool = choices.length ? choices : items;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const strip: RouletteItem[] = [];

    for (let i = 0; i < RUNWAY; i++) {
      strip.push(items[Math.floor(Math.random() * items.length)]);
    }

    strip.push(pick);

    // A few tiles after the winner so the reel does not end at a visible edge.
    for (let i = 0; i < 4; i++) {
      strip.push(items[Math.floor(Math.random() * items.length)]);
    }

    lastWinnerRef.current = pick?.tmdbId ?? null;

    return { reel: strip, winner: pick };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, spinKey]);

  /*
   * The overlay renders nothing on its first pass (see the portal below), so
   * the reel does not exist yet. The spin waits for it: measuring an absent
   * reel gave a width of 0, which put the winner's centre at the reel's left
   * edge, half a reel short of the pointer — the first spin only, since every
   * later spin starts with the reel on screen.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) {
      return;
    }

    setSpinning(true);
    setOffset(0);

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // Centre the winning tile under the marker: its centre sits TILE_WIDTH / 2
    // past its left edge, and the marker is half the reel's width in.
    // Measured when used, so it is always the laid-out width.
    const targetFor = () =>
      RUNWAY * TILE_STRIDE +
      TILE_WIDTH / 2 -
      (viewportRef.current?.offsetWidth ?? 0) / 2;

    setAnimating(false);

    if (prefersReducedMotion) {
      setOffset(targetFor());
      setSpinning(false);
      return;
    }

    // Two frames: the first paints at zero so the transition has somewhere to
    // travel from, rather than jumping straight to the end.
    // First frame paints at zero with no transition; the second turns the
    // transition back on and sends it to the target.
    // Two frames: the reel resets, then animates. Both are tracked, so closing
    // between them cannot leave the second to fire on a component that is gone.
    let innerRaf = 0;
    const raf = requestAnimationFrame(() => {
      innerRaf = requestAnimationFrame(() => {
        setAnimating(true);
        setOffset(targetFor());
      });
    });

    const timer = setTimeout(() => setSpinning(false), SPIN_MS);

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(innerRaf);
      clearTimeout(timer);
    };
  }, [spinKey, mounted]);

  /*
   * Rendered into the top of the page, like the app's Modal, rather than
   * where the list happens to sit. The page content lives in a z-0 layer, so
   * inline the overlay was trapped beneath the bottom navigation bar on a
   * phone and the sidebar on desktop. The page behind is locked from
   * scrolling, as it is under every other dialog.
   */
  useLockBodyScroll(true);

  if (!mounted) {
    return null;
  }

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-strong/90 px-4"
      // Keeps the card clear of the notch and home bar in the installed app,
      // which draws edge to edge; both are zero in a normal browser.
      style={{
        paddingTop: 'max(1rem, env(safe-area-inset-top))',
        paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
      }}
    >
      <div className="w-full max-w-2xl rounded-xl border border-subtle bg-surface p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-strong">
            {isSpinning
              ? intl.formatMessage(messages.spinning)
              : intl.formatMessage(messages.yourpick)}
          </h2>
          <button
            aria-label={intl.formatMessage(messages.close)}
            className="text-muted hover:text-strong"
            onClick={onClose}
            type="button"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        <div
          className="relative overflow-hidden rounded-lg bg-page py-4"
          ref={viewportRef}
        >
          {/* Marker the reel lands under. */}
          <div className="pointer-events-none absolute inset-y-0 left-1/2 z-20 w-0.5 -translate-x-1/2 bg-indigo-500" />
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-page to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-page to-transparent" />

          <div
            className="flex"
            style={{
              gap: `${TILE_GAP}px`,
              transform: `translate3d(-${offset}px, 0, 0)`,
              // Fast to begin with, then a long glide into the result.
              transition: animating
                ? `transform ${SPIN_MS}ms cubic-bezier(0.12, 0.8, 0.12, 1)`
                : 'none',
              willChange: 'transform',
            }}
          >
            {reel.map((item, index) => (
              <div
                className={`flex-none overflow-hidden rounded-md bg-surface transition duration-300 ${
                  !isSpinning && index === RUNWAY
                    ? 'ring-2 ring-indigo-400'
                    : !isSpinning
                      ? 'opacity-40'
                      : ''
                }`}
                key={`reel-${index}`}
                style={{ width: TILE_WIDTH, height: TILE_WIDTH * 1.5 }}
              >
                {item.posterPath && (
                  <PosterBackground
                    className="h-full w-full bg-cover bg-center"
                    posterPath={item.posterPath}
                    size="w342"
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <p className="min-w-0 truncate text-lg font-bold text-strong">
            {isSpinning ? '\u00A0' : (winner.title ?? '')}
          </p>
          <div className="ml-4 flex flex-none space-x-2">
            <Button
              disabled={isSpinning}
              onClick={() => setSpinKey((k) => k + 1)}
            >
              {intl.formatMessage(messages.spinagain)}
            </Button>
            {!isSpinning && (
              <Link
                href={`/${winner.mediaType === 'tv' ? 'tv' : 'movie'}/${
                  winner.tmdbId
                }`}
                legacyBehavior
                passHref
              >
                <Button as="a" buttonType="primary">
                  {intl.formatMessage(messages.open)}
                </Button>
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default Roulette;
