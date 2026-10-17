/*
 * The choices that make up how Seerr AI looks: light or dark, the accent
 * colour, the dark background and a few extras. Each person can choose
 * their own (Profile → Settings → Appearance, kept in their user settings);
 * an admin chooses the server's default (Settings → Appearance), which is
 * what everyone else sees, the sign-in page included. The colours each
 * choice stands for are in src/utils/theme; this is only what may be kept.
 */

import type { ThemeFile } from '@server/constants/themeFile';
import { cleanThemeFile, withoutThemeFile } from '@server/constants/themeFile';

export const THEME_MODES = ['dark', 'light', 'auto'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Indigo is how Seerr AI has always looked. */
export const THEME_ACCENTS = [
  'indigo',
  'seerr',
  'teal',
  'green',
  'rose',
  'amber',
  'plex',
  'jellyfin',
  'custom',
] as const;
export type ThemeAccent = (typeof THEME_ACCENTS)[number];

/** The background used whenever it is dark. Classic is today's. */
export const THEME_BACKGROUNDS = ['classic', 'black', 'slate', 'warm'] as const;
export type ThemeBackground = (typeof THEME_BACKGROUNDS)[number];

export const THEME_SPACINGS = ['comfortable', 'compact'] as const;
export type ThemeSpacing = (typeof THEME_SPACINGS)[number];

export const THEME_CORNERS = ['rounded', 'square'] as const;
export type ThemeCorners = (typeof THEME_CORNERS)[number];

/** What an admin sets for everyone who has not chosen their own. */
export interface ThemeDefaults {
  mode: ThemeMode;
  accent: ThemeAccent;
  /** '#rrggbb', only with the custom accent. */
  customAccent?: string;
  background: ThemeBackground;
  /**
   * A theme file in use (server/constants/themeFile.ts): its colours take
   * the place of the accent's and background's wherever it gives them.
   */
  theme?: ThemeFile;
}

/** A person's own look: the server's choices plus the extras. */
export interface Appearance extends ThemeDefaults {
  spacing: ThemeSpacing;
  corners: ThemeCorners;
  /**
   * The softened backdrop behind a film or series. Off unless chosen, so
   * title pages look as they always have.
   */
  blur: boolean;
  /** Solid panels instead of see-through ones. */
  solidPanels: boolean;
  /** Seasonal themes shown on top of their own, when the server has one on. */
  seasonal: boolean;
}

export const SERVER_THEME_DEFAULTS: ThemeDefaults = {
  mode: 'dark',
  accent: 'indigo',
  background: 'classic',
};

const EXTRAS_DEFAULTS = {
  spacing: 'comfortable',
  corners: 'rounded',
  blur: false,
  solidPanels: false,
  seasonal: true,
} as const satisfies Omit<Appearance, keyof ThemeDefaults>;

const DEFAULT_KEYS = ['mode', 'accent', 'customAccent', 'background', 'theme'];
const EXTRA_KEYS = Object.keys(EXTRAS_DEFAULTS);

const oneOf = <T extends string>(
  list: readonly T[],
  value: unknown
): value is T => list.includes(value as T);

/**
 * A colour as it is kept: '#rrggbb' in lower case ('#rgb' is widened).
 * Undefined for anything else, so nothing but a colour can be stored.
 */
export const cleanHexColour = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) {
    return hex;
  }
  if (/^#[0-9a-f]{3}$/.test(hex)) {
    return `#${[...hex.slice(1)].map((digit) => digit + digit).join('')}`;
  }
  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const cleanDefaultsPart = (
  value: Record<string, unknown>
): ThemeDefaults | undefined => {
  if (
    !oneOf(THEME_MODES, value.mode) ||
    !oneOf(THEME_ACCENTS, value.accent) ||
    !oneOf(THEME_BACKGROUNDS, value.background)
  ) {
    return undefined;
  }
  // A theme file is checked as strictly as one being imported; one that
  // fails makes the whole look unusable rather than quietly dropping it.
  const theme =
    value.theme === undefined ? undefined : cleanThemeFile(value.theme);
  if (value.theme !== undefined && !theme) {
    return undefined;
  }
  const withTheme = theme ? { theme } : {};
  if (value.accent !== 'custom') {
    return {
      mode: value.mode,
      accent: value.accent,
      background: value.background,
      ...withTheme,
    };
  }
  const customAccent = cleanHexColour(value.customAccent);
  return customAccent
    ? {
        mode: value.mode,
        accent: value.accent,
        customAccent,
        background: value.background,
        ...withTheme,
      }
    : undefined;
};

/**
 * The server's default as it is kept, or undefined if any part of it is
 * unknown or missing.
 */
export const cleanThemeDefaults = (
  value: unknown
): ThemeDefaults | undefined =>
  isRecord(value) &&
  Object.keys(value).every((key) => DEFAULT_KEYS.includes(key))
    ? cleanDefaultsPart(value)
    : undefined;

/**
 * A person's look as it is kept, or undefined if anything in it is unknown
 * or not what it should be. The extras may be left out (they take their
 * usual values); the mode, accent and background may not.
 */
export const cleanAppearance = (value: unknown): Appearance | undefined => {
  if (
    !isRecord(value) ||
    !Object.keys(value).every(
      (key) => DEFAULT_KEYS.includes(key) || EXTRA_KEYS.includes(key)
    )
  ) {
    return undefined;
  }
  const defaults = cleanDefaultsPart(value);
  const extras = { ...EXTRAS_DEFAULTS, ...value };
  if (
    !defaults ||
    !oneOf(THEME_SPACINGS, extras.spacing) ||
    !oneOf(THEME_CORNERS, extras.corners) ||
    typeof extras.blur !== 'boolean' ||
    typeof extras.solidPanels !== 'boolean' ||
    typeof extras.seasonal !== 'boolean'
  ) {
    return undefined;
  }
  return {
    ...defaults,
    spacing: extras.spacing,
    corners: extras.corners,
    blur: extras.blur,
    solidPanels: extras.solidPanels,
    seasonal: extras.seasonal,
  };
};

/** The look of someone who has not chosen their own. */
export const appearanceFromDefaults = (
  defaults: ThemeDefaults
): Appearance => ({ ...defaults, ...EXTRAS_DEFAULTS });

/*
 * A copy of the person's look is kept in a cookie on their device, so pages
 * shown before anyone signs in (the sign-in page) look the way they left
 * it. It is only ever a copy: their account decides once they are signed
 * in, and the server reads it as strictly as anything sent to it.
 */
export const THEME_COOKIE = 'seerr-theme';

/** A theme file is left out: cookies are small, and the account has it. */
export const appearanceCookieValue = (appearance: Appearance): string =>
  encodeURIComponent(JSON.stringify(withoutThemeFile(appearance)));

export const appearanceFromCookie = (
  header: string | undefined
): Appearance | undefined => {
  const raw = header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${THEME_COOKIE}=`))
    ?.slice(THEME_COOKIE.length + 1);
  if (!raw) {
    return undefined;
  }
  try {
    return cleanAppearance(JSON.parse(decodeURIComponent(raw)));
  } catch {
    return undefined;
  }
};
