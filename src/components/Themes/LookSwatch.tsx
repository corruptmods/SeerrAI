import { accentColours, neutralsFor } from '@app/utils/theme';
import type { Appearance, ThemeDefaults } from '@server/constants/theme';

/**
 * A small picture of a look in one mode: its page, a panel with text, and
 * a button in its accent. Drawn in the look's own colours, whatever look
 * the page around it is in. Decorative: the name beside it says which.
 */
const LookSwatch = ({
  look,
  mode,
  className = 'h-14',
}: {
  look: ThemeDefaults | Appearance;
  mode: 'dark' | 'light';
  className?: string;
}) => {
  const n = neutralsFor(look, mode);
  const accent = accentColours(look);
  return (
    <span
      aria-hidden="true"
      className={`flex w-full items-end gap-1.5 rounded-md border p-2 ${className}`}
      style={{ backgroundColor: n.page, borderColor: n.borderSubtle }}
    >
      <span
        className="flex h-full flex-1 flex-col justify-center gap-1 rounded-sm px-1.5"
        style={{ backgroundColor: n.surface }}
      >
        <span
          className="h-1.5 w-3/4 rounded-full"
          style={{ backgroundColor: n.textStrong }}
        />
        <span
          className="h-1.5 w-1/2 rounded-full"
          style={{ backgroundColor: n.textMuted }}
        />
      </span>
      <span
        className="flex h-5 w-1/4 items-center justify-center rounded-sm"
        style={{ backgroundColor: accent.fill }}
      >
        <span
          className="h-1 w-1/2 rounded-full"
          style={{ backgroundColor: accent.ink }}
        />
      </span>
    </span>
  );
};

export default LookSwatch;
