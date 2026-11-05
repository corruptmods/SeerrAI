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

/** Tile width and gap; the reel maths requires these to match the CSS. */
const TILE_WIDTH = 120;
const TILE_GAP = 12;
const TILE_STRIDE = TILE_WIDTH + TILE_GAP;

/** Tiles that pass before the winner. */
const RUNWAY = 34;
const SPIN_MS = 4200;

const Roulette = ({ items, onClose }: RouletteProps) => {
  const intl = useIntl();
  const [spinKey, setSpinKey] = useState(0);
  const [isSpinning, setSpinning] = useState(true);
  const [offset, setOffset] = useState(0);
  /*
   * The reel must jump back to the start without a transition before each
   * spin, or "Spin again" slides to almost the same place.
   */
  const [animating, setAnimating] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  /** The previous pick, so spinning again offers something else. */
  const lastWinnerRef = useRef<number | null>(null);

  // The winner is picked first and the reel built to end on it, so the
  // animation always matches the result.
  const { reel, winner } = useMemo(() => {
    // Never repeat the title just rejected.
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

    // Tiles after the winner, so the reel doesn't end at a visible edge.
    for (let i = 0; i < 4; i++) {
      strip.push(items[Math.floor(Math.random() * items.length)]);
    }

    lastWinnerRef.current = pick?.tmdbId ?? null;

    return { reel: strip, winner: pick };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, spinKey]);

  /*
   * The overlay renders nothing on its first pass (see the portal below), so
   * the spin waits for the reel: measuring it absent gives width 0 and lands
   * the first spin half a reel short.
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

    // Centre the winner under the marker, half the reel's width in. Measured
    // when used, so it is the laid-out width.
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

    // Two frames: the first paints at zero without a transition, the second
    // animates to the target. Both are tracked, so unmounting between them
    // cancels the second.
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
   * Portalled to the top of the page, like Modal: page content is in a z-0
   * layer, so inline it would sit beneath the tab bar and sidebar.
   */
  useLockBodyScroll(true);

  if (!mounted) {
    return null;
  }

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay-strong/90 px-4"
      // Clears the notch and home bar in the edge-to-edge installed app; both
      // are zero in a browser.
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
              // Fast start, then a long glide.
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
          <p className="min-w-0 break-words text-lg font-bold text-strong">
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
