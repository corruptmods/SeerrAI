/*
 * A theme file's colours in place of a look's (the format is in
 * server/constants/themeFile.ts). Used by neutralsFor and accentColours, so
 * everything that reads a look's colours gets the file's.
 */
import type {
  ThemeFileAccent,
  ThemeFileMode,
} from '@server/constants/themeFile';
import type { AccentColours, Scale } from './colour';
import { accentFromColour } from './colour';
import type { Neutrals } from './palette';

/** A look's colours for one mode, with a theme file's in their place. */
export const neutralsWithThemeFile = (
  neutrals: Neutrals,
  part: ThemeFileMode | undefined
): Neutrals => {
  if (!part) {
    return neutrals;
  }
  const { gray, ...colours } = part;
  return {
    ...neutrals,
    ...colours,
    gray: { ...neutrals.gray, ...gray } as Scale,
  };
};

/**
 * A look's accent with a theme file's in its place. A file's fill makes a
 * whole accent, as a custom colour does; anything else it gives is used
 * as it is.
 */
export const accentWithThemeFile = (
  accent: AccentColours,
  file: ThemeFileAccent | undefined
): AccentColours => {
  if (!file) {
    return accent;
  }
  const base =
    file.fill && file.fill !== accent.fill
      ? accentFromColour(file.fill)
      : accent;
  const ink = file.ink ?? base.ink;
  return {
    ...base,
    scale: { ...base.scale, ...file.scale } as Scale,
    alt: { ...base.alt, ...file.alt } as Scale,
    ink,
    inkIsDark: ink !== '#ffffff',
    dark: { ...base.dark, ...file.dark },
    light: { ...base.light, ...file.light },
  };
};
