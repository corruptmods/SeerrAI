// Appearance choices: light or dark, accent colour, dark background and a few
// extras. Users choose their own (Profile → Settings → Appearance, in user
// settings); an admin sets the server default (Settings → Appearance), which
// everyone else sees, sign-in page included. The colours behind each choice are
// in src/utils/theme; this only defines what may be stored.

import type { ThemeFile } from '@server/constants/themeFile';
import { cleanThemeFile, withoutThemeFile } from '@server/constants/themeFile';

export const THEME_MODES = ['dark', 'light', 'auto'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Indigo is the original look. */
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

/** The dark-mode background. Classic is the original. */
export const THEME_BACKGROUNDS = ['classic', 'black', 'slate', 'warm'] as const;
export type ThemeBackground = (typeof THEME_BACKGROUNDS)[number];

export const THEME_SPACINGS = ['comfortable', 'compact'] as const;
export type ThemeSpacing = (typeof THEME_SPACINGS)[number];

export const THEME_CORNERS = ['rounded', 'square'] as const;
export type ThemeCorners = (typeof THEME_CORNERS)[number];

/** The admin's default for everyone who hasn't chosen their own. */
export interface ThemeDefaults {
  mode: ThemeMode;
  accent: ThemeAccent;
  /** '#rrggbb', only with the custom accent. */
  customAccent?: string;
  background: ThemeBackground;
  /**
   * A theme file in use (server/constants/themeFile.ts); its colours replace
   * the accent's and background's wherever it sets them.
   */
  theme?: ThemeFile;
}

/** A user's look: the server's choices plus the extras. */
export interface Appearance extends ThemeDefaults {
  spacing: ThemeSpacing;
  corners: ThemeCorners;
  /**
   * The softened backdrop behind a film or series. Off by default, so title
   * pages keep their original look.
   */
  blur: boolean;
  /** Solid panels instead of translucent ones. */
  solidPanels: boolean;
  /** Show the server's seasonal theme, when one is on, over their own. */
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
 * A colour as stored: lowercase '#rrggbb' ('#rgb' is expanded). Undefined for
 * anything else, so only colours are stored.
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
  // Check a theme file as strictly as on import; a failing one makes the whole
  // look invalid rather than being silently dropped.
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
 * The server default as stored, or undefined if any part is unknown or missing.
 */
export const cleanThemeDefaults = (
  value: unknown
): ThemeDefaults | undefined =>
  isRecord(value) &&
  Object.keys(value).every((key) => DEFAULT_KEYS.includes(key))
    ? cleanDefaultsPart(value)
    : undefined;

/**
 * A user's look as stored, or undefined if anything is unknown or invalid.
 * Extras may be omitted (they take defaults); mode, accent and background may
 * not.
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

/** The look for someone who hasn't chosen their own. */
export const appearanceFromDefaults = (
  defaults: ThemeDefaults
): Appearance => ({ ...defaults, ...EXTRAS_DEFAULTS });

// A copy of the user's look is kept in a device cookie, so pages shown before
// sign-in look as they left them. Only a copy: the account decides once signed
// in, and the server validates it as strictly as any input.
export const THEME_COOKIE = 'seerr-theme';

/** Omits the theme file: cookies are small, and the account has it. */
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
