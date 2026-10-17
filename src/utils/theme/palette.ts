/*
 * The colours behind every built-in choice. Classic with Indigo is how
 * Seerr AI has always looked, value for value (globals.css carries the same
 * values as the page's fallback, and theme.test.ts checks they agree).
 */
import type { ThemeAccent, ThemeBackground } from '@server/constants/theme';
import type { AccentColours, Scale } from './colour';
import { SCALE_STEPS, accentFromColour, accentFromScale } from './colour';

/** The greys of one background, and what each surface and text uses. */
export interface Neutrals {
  gray: Scale;
  page: string;
  surface: string;
  surfaceRaised: string;
  /** The sidebar's gradient, top to bottom. */
  sidebar: string;
  sidebarTo: string;
  /** Dims the page behind a window; always dark. */
  overlay: string;
  overlayStrong: string;
  /** Behind text on pictures; always dark. */
  mediaScrim: string;
  textStrong: string;
  textDefault: string;
  textMuted: string;
  borderSubtle: string;
  borderStrong: string;
  field: string;
  fieldBorder: string;
}

/** A scale from its eleven colours, 50 to 950, separated by spaces. */
const scale = (hexes: string): Scale =>
  Object.fromEntries(
    hexes.split(' ').map((hex, i) => [SCALE_STEPS[i], hex])
  ) as Scale;

/** A dark background's surfaces, from its greys. */
const darkNeutrals = (
  gray: Scale,
  sidebar: string,
  sidebarTo: string
): Neutrals => ({
  gray,
  page: gray[900],
  surface: gray[800],
  surfaceRaised: gray[700],
  sidebar,
  sidebarTo,
  overlay: gray[800],
  overlayStrong: gray[900],
  mediaScrim: gray[900],
  textStrong: '#ffffff',
  textDefault: gray[300],
  textMuted: gray[400],
  borderSubtle: gray[700],
  borderStrong: gray[600],
  field: gray[700],
  fieldBorder: gray[500],
});

export const DARK_BACKGROUNDS: Record<ThemeBackground, Neutrals> = {
  // Tailwind's gray: today's colours.
  classic: darkNeutrals(
    scale(
      '#f9fafb #f3f4f6 #e5e7eb #d1d5db #9ca3af #6b7280 ' +
        '#4b5563 #374151 #1f2937 #111827 #030712'
    ),
    '#1f2937',
    '#131928'
  ),
  // Neutral greys down to black, for OLED screens.
  black: darkNeutrals(
    scale(
      '#fafafa #f5f5f5 #e5e5e5 #d4d4d4 #a3a3a3 #737373 ' +
        '#525252 #2e2e2e #141414 #000000 #000000'
    ),
    '#141414',
    '#0a0a0a'
  ),
  // Tailwind's slate: a cooler blue-grey.
  slate: darkNeutrals(
    scale(
      '#f8fafc #f1f5f9 #e2e8f0 #cbd5e1 #94a3b8 #64748b ' +
        '#475569 #334155 #1e293b #0f172a #020617'
    ),
    '#1e293b',
    '#152036'
  ),
  // Tailwind's stone: a warmer brown-grey.
  warm: darkNeutrals(
    scale(
      '#fafaf9 #f5f5f4 #e7e5e4 #d6d3d1 #a8a29e #78716c ' +
        '#57534e #44403c #292524 #1c1917 #0c0a09'
    ),
    '#292524',
    '#231f1c'
  ),
};

/*
 * Light. The greys run the other way round, so a page not yet given its own
 * light colours (bg-gray-900, text-gray-300) still comes out light with dark
 * text: 900 is the page, 800 a white panel, 300 and 400 dark enough to read.
 */
export const LIGHT: Neutrals = {
  gray: scale(
    '#030712 #111827 #1f2937 #374151 #4b5563 #6b7280 ' +
      '#9ca3af #d1d5db #ffffff #f3f4f6 #e5e7eb'
  ),
  page: '#f3f4f6',
  surface: '#ffffff',
  surfaceRaised: '#e5e7eb',
  sidebar: '#ffffff',
  sidebarTo: '#f9fafb',
  overlay: '#111827',
  overlayStrong: '#111827',
  mediaScrim: '#111827',
  textStrong: '#111827',
  textDefault: '#374151',
  textMuted: '#4b5563',
  borderSubtle: '#d1d5db',
  borderStrong: '#9ca3af',
  field: '#ffffff',
  fieldBorder: '#6b7280',
};

/** Success, warning, danger and info: a fill, text on the page, a tint. */
export interface StatusColours {
  fill: string;
  text: string;
  soft: string;
}
export type Status = 'success' | 'warning' | 'danger' | 'info';

export const STATUS: Record<'dark' | 'light', Record<Status, StatusColours>> = {
  // Today's: what buttons, badges, alerts and toasts already use.
  dark: {
    success: { fill: '#22c55e', text: '#4ade80', soft: '#22c55e' },
    warning: { fill: '#eab308', text: '#eab308', soft: '#facc15' },
    danger: { fill: '#dc2626', text: '#ef4444', soft: '#dc2626' },
    info: { fill: '#6366f1', text: '#6366f1', soft: '#818cf8' },
  },
  // Darker, solid fills under white text, and text dark enough to read on
  // white and on the page.
  light: {
    success: { fill: '#15803d', text: '#15803d', soft: '#22c55e' },
    warning: { fill: '#b45309', text: '#854d0e', soft: '#eab308' },
    danger: { fill: '#b91c1c', text: '#b91c1c', soft: '#ef4444' },
    info: { fill: '#4338ca', text: '#4338ca', soft: '#6366f1' },
  },
};

/*
 * True black, Slate and Warm. Classic keeps today's colours above, some of
 * which reach only 3:1; these have no today to keep, so their fills are a
 * step deeper (white on buttons and the pale text on badges read over them)
 * and danger and info text is light enough for 4.5:1.
 */
export const OTHER_DARK_STATUS: Record<Status, StatusColours> = {
  success: { fill: '#15803d', text: '#4ade80', soft: '#22c55e' },
  warning: { fill: '#a16207', text: '#eab308', soft: '#facc15' },
  danger: { fill: '#b91c1c', text: '#f87171', soft: '#dc2626' },
  info: { fill: '#4f46e5', text: '#818cf8', soft: '#818cf8' },
};

const INDIGO = scale(
  '#eef2ff #e0e7ff #c7d2fe #a5b4fc #818cf8 #6366f1 ' +
    '#4f46e5 #4338ca #3730a3 #312e81 #1e1b4b'
);
const PURPLE = scale(
  '#faf5ff #f3e8ff #e9d5ff #d8b4fe #c084fc #a855f7 ' +
    '#9333ea #7e22ce #6b21a8 #581c87 #3b0764'
);

/*
 * The approved design's text on each accent's buttons and its link colour
 * in dark and in light; the rest (hovers, tints, gradients) comes from the
 * accent's scale. theme.test.ts checks every one of them reads.
 */
export const asDesigned = (
  accent: AccentColours,
  ink: string,
  darkText: string,
  lightText: string
): AccentColours => ({
  ...accent,
  ink,
  inkIsDark: ink !== '#ffffff',
  dark: { ...accent.dark, text: darkText, soft: darkText, onChip: ink },
  light: { ...accent.light, text: lightText, onChip: ink },
});

/** Dark text on the yellow accents. */
const WARM_INK = '#1c1917';

/*
 * Indigo is today's, exactly: buttons indigo-600 lightening to indigo-500,
 * links and active tabs indigo-500, gradients into purple, badges
 * indigo-500 with indigo-100 text. Its link colour in dark (4:1 on the
 * page) is below what the other accents reach; it is kept so that Classic
 * does not change for anyone.
 */
const indigo = (): AccentColours => {
  const accent = asDesigned(
    accentFromScale(INDIGO, 600, PURPLE),
    '#ffffff',
    INDIGO[500],
    INDIGO[700]
  );
  return {
    ...accent,
    dark: {
      hover: INDIGO[500],
      text: INDIGO[500],
      soft: INDIGO[400],
      alt: PURPLE[600],
      altHover: PURPLE[500],
      chip: INDIGO[500],
      onChip: INDIGO[100],
    },
  };
};

export const ACCENTS: Record<Exclude<ThemeAccent, 'custom'>, AccentColours> = {
  indigo: indigo(),
  // The Seerr AI logo's violet.
  seerr: asDesigned(
    accentFromColour('#7357f0'),
    '#ffffff',
    '#b39afc',
    '#5b3fd9'
  ),
  teal: asDesigned(
    accentFromScale(
      scale(
        '#f0fdfa #ccfbf1 #99f6e4 #5eead4 #2dd4bf #14b8a6 ' +
          '#0d9488 #0f766e #115e59 #134e4a #042f2e'
      ),
      700
    ),
    '#ffffff',
    '#2dd4bf',
    '#0f766e'
  ),
  green: asDesigned(
    accentFromScale(
      scale(
        '#f0fdf4 #dcfce7 #bbf7d0 #86efac #4ade80 #22c55e ' +
          '#16a34a #15803d #166534 #14532d #052e16'
      ),
      700
    ),
    '#ffffff',
    '#4ade80',
    '#15803d'
  ),
  rose: asDesigned(
    accentFromScale(
      scale(
        '#fff1f2 #ffe4e6 #fecdd3 #fda4af #fb7185 #f43f5e ' +
          '#e11d48 #be123c #9f1239 #881337 #4c0519'
      ),
      700
    ),
    '#ffffff',
    '#fb7185',
    '#be123c'
  ),
  amber: asDesigned(
    accentFromScale(
      scale(
        '#fffbeb #fef3c7 #fde68a #fcd34d #fbbf24 #f59e0b ' +
          '#d97706 #b45309 #92400e #78350f #451a03'
      ),
      500
    ),
    WARM_INK,
    '#fbbf24',
    '#92400e'
  ),
  // Plex's and Jellyfin's own colours.
  plex: asDesigned(accentFromColour('#e5a00d'), WARM_INK, '#f5b82e', '#8a5a00'),
  jellyfin: asDesigned(
    accentFromColour('#9b4dca'),
    '#ffffff',
    '#c99ae6',
    '#7e34ab'
  ),
};

/** The colour a custom accent starts from before anyone picks one. */
export const CUSTOM_ACCENT_START = '#0ea5e9';
