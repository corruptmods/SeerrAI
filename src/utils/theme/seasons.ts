/*
 * The colours of each seasonal theme (server/lib/seasons says when they
 * run). A season sits on top of the person's own look: its accent replaces
 * theirs, in dark mode its night-time background replaces their dark
 * background, and light mode stays light. Their extras (spacing, corners,
 * solid panels) are kept. seasons.test.ts checks every colour reads.
 *
 * Halloween, Holidays and New Year are the approved design's colours.
 */
import type { SeasonId } from '@server/lib/seasons';
import type { AccentColours, Oklch, Scale, ScaleStep } from './colour';
import {
  accentFromColour,
  fromOklch,
  hexToRgb,
  rgbToHex,
  toOklch,
} from './colour';
import type { Neutrals } from './palette';
import { asDesigned } from './palette';

export interface SeasonLook {
  accent: AccentColours;
  /** Dark mode's background while the season runs. */
  night: Neutrals;
  /** The mark by the logo, in dark and in light. */
  mark: { dark: string; light: string };
  /** The mark's drawing: lines on a 24-unit square, in the mark's colour. */
  icon: { d: string }[];
}

const oklch = (hex: string): Oklch => toOklch(hexToRgb(hex));

/** A colour part of the way from one to another, as the eye sees it. */
const between = (from: string, to: string, part: number): string => {
  const a = oklch(from);
  const b = oklch(to);
  return rgbToHex(
    fromOklch({
      l: a.l + (b.l - a.l) * part,
      c: a.c + (b.c - a.c) * part,
      h: b.h,
    })
  );
};

/**
 * A season's night from the few colours the design gives it. The greys in
 * between run from its panels to its quiet text and on to its text, so
 * anything still using a grey (gray-300, gray-600, …) takes the season's
 * tint too.
 */
const night = ({
  page,
  sidebarTo,
  surface,
  raised,
  text,
  muted,
}: {
  page: string;
  sidebarTo: string;
  surface: string;
  raised: string;
  text: string;
  muted: string;
}): Neutrals => {
  const darkest = oklch(page);
  const gray: Scale = {
    50: text,
    100: between(muted, text, 0.85),
    200: between(muted, text, 2 / 3),
    300: between(muted, text, 1 / 3),
    400: muted,
    500: between(raised, muted, 2 / 3),
    600: between(raised, muted, 1 / 3),
    // Lines are often drawn in gray-700 on gray-800: a little lighter than
    // the raised panels the design pairs with its surface, so they show as
    // clearly as in the other dark backgrounds.
    700: between(raised, muted, 0.1),
    800: surface,
    900: page,
    950: rgbToHex(fromOklch({ ...darkest, l: darkest.l * 0.7 })),
  } satisfies Record<ScaleStep, string>;
  return {
    gray,
    page,
    surface,
    surfaceRaised: raised,
    sidebar: surface,
    sidebarTo,
    overlay: surface,
    overlayStrong: page,
    mediaScrim: page,
    textStrong: text,
    textDefault: gray[300],
    textMuted: muted,
    borderSubtle: gray[700],
    borderStrong: gray[600],
    field: raised,
    fieldBorder: gray[500],
  };
};

/** Dark text on the bright accents. */
const WARM_INK = '#1c1917';

const MOON = 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z';
const STAR =
  'M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6l-5.4 2.9 1.2-6-4.5-4.2 6.1-.7Z';
const SPARK =
  'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6';
const LANTERN =
  'M12 2v2.5M9.5 4.5h5M12 4.5c3.3 0 6 2.5 6 6s-2.7 6-6 6-6-2.5-6-6 2.7-6 6-6ZM12 4.5c-1.6 1.6-2.4 3.6-2.4 6s.8 4.4 2.4 6M12 4.5c1.6 1.6 2.4 3.6 2.4 6s-.8 4.4-2.4 6M9.5 16.5h5M12 16.5V22';

export const SEASON_LOOKS: Record<SeasonId, SeasonLook> = {
  // Pumpkin orange on a deep purple night, with a crescent moon.
  halloween: {
    accent: asDesigned(
      accentFromColour('#f97316'),
      WARM_INK,
      '#fb923c',
      '#c2410c'
    ),
    night: night({
      page: '#120d1c',
      sidebarTo: '#181026',
      surface: '#1f1631',
      raised: '#30254a',
      text: '#f5f3ff',
      muted: '#ab9fc4',
    }),
    mark: { dark: '#fb923c', light: '#c2410c' },
    icon: [{ d: MOON }],
  },
  // Evergreen with a gold star; no snow, as December is summer for half
  // the world.
  holidays: {
    accent: asDesigned(
      accentFromColour('#15803d'),
      '#ffffff',
      '#4ade80',
      '#15803d'
    ),
    night: night({
      page: '#0c1612',
      sidebarTo: '#10201a',
      surface: '#14251d',
      raised: '#21392c',
      text: '#f0fdf4',
      muted: '#a3bcae',
    }),
    mark: { dark: '#fbbf24', light: '#b45309' },
    icon: [{ d: STAR }],
  },
  // Champagne gold on midnight blue, with a spark.
  newyear: {
    accent: asDesigned(
      accentFromColour('#fbbf24'),
      WARM_INK,
      '#fcd34d',
      '#92400e'
    ),
    night: night({
      page: '#0b0e1f',
      sidebarTo: '#10142b',
      surface: '#161b38',
      raised: '#252c55',
      text: '#f5f6ff',
      muted: '#a6abcf',
    }),
    mark: { dark: '#fcd34d', light: '#92400e' },
    icon: [{ d: SPARK }],
  },
  // Lantern red on a deep red night.
  lunarnewyear: {
    accent: asDesigned(
      accentFromColour('#b91c1c'),
      '#ffffff',
      '#f87171',
      '#b91c1c'
    ),
    night: night({
      page: '#170b0b',
      sidebarTo: '#1f0f0f',
      surface: '#281414',
      raised: '#42201f',
      text: '#fff5f5',
      muted: '#c4a4a2',
    }),
    mark: { dark: '#fbbf24', light: '#b91c1c' },
    icon: [{ d: LANTERN }],
  },
};
