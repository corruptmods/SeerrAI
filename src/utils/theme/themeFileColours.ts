/*
 * Overrides a look's colours with a theme file's (format in
 * server/constants/themeFile.ts). Used by neutralsFor and accentColours.
 */
import type {
  ThemeFileAccent,
  ThemeFileMode,
} from '@server/constants/themeFile';
import type { AccentColours, Scale } from './colour';
import { accentFromColour } from './colour';
import type { Neutrals } from './palette';

/** A look's colours for one mode, overridden by the theme file. */
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
 * A look's accent overridden by the theme file. Its fill builds a whole
 * accent like a custom colour; other values are used as given.
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
