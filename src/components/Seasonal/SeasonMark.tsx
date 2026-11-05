import { useTheme } from '@app/context/ThemeContext';
import { SEASON_LOOKS } from '@app/utils/theme/seasons';
import { Transition } from '@headlessui/react';
import type { SeasonId } from '@server/lib/seasons';

/** A season's decorative icon (moon, star, spark…); named in text wherever it matters. */
export const SeasonIcon = ({
  season,
  className,
  colour,
}: {
  season: SeasonId;
  className?: string;
  /** Defaults to the season's on-screen colour. */
  colour?: string;
}) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={{ color: colour ?? 'rgb(var(--season-mark))' }}
  >
    {SEASON_LOOKS[season].icon.map((line) => (
      <path key={line.d} d={line.d} stroke="currentColor" />
    ))}
  </svg>
);

/** The mark beside the logo during a season; fades in unless reduced motion is set. */
const SeasonMark = ({ className }: { className?: string }) => {
  const { season } = useTheme();
  return (
    <Transition
      show={!!season}
      appear
      as="span"
      data-seerr="season-mark"
      enter="motion-safe:transition motion-safe:duration-700"
      enterFrom="motion-safe:opacity-0 motion-safe:scale-50"
      enterTo="opacity-100 scale-100"
      className={`pointer-events-none block ${className ?? ''}`}
    >
      {season && <SeasonIcon season={season} className="h-full w-full" />}
    </Transition>
  );
};

export default SeasonMark;
