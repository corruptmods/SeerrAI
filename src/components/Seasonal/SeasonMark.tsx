import { useTheme } from '@app/context/ThemeContext';
import { SEASON_LOOKS } from '@app/utils/theme/seasons';
import { Transition } from '@headlessui/react';
import type { SeasonId } from '@server/lib/seasons';

/**
 * A season's small mark: a moon for Halloween, a star for the holidays, a
 * spark for New Year, and so on. Only a picture; the season is named in
 * words wherever it matters.
 */
export const SeasonIcon = ({
  season,
  className,
  colour,
}: {
  season: SeasonId;
  className?: string;
  /** Its colour; the season's own, on screen, if left out. */
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
      <path key={line.d} d={line.d} stroke={line.colour ?? 'currentColor'} />
    ))}
  </svg>
);

/**
 * The mark by the logo while a season shows. It fades in, except for
 * people who have asked their device for less motion.
 */
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
