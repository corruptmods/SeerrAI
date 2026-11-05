/*
 * Theme files: a shareable look, exported from one Appearance page and
 * imported on another (or by an admin as the server default). Only colours
 * and a few known settings, so updates can't break one and one can't carry
 * anything else onto the page:
 *
 *   {
 *     "seerrTheme": 1,
 *     "name": "Ember",
 *     "author": "Sam",                      optional
 *     "dark":   { "page": "#1c1917", …,     the colours used when dark
 *                 "gray": { "900": … } },
 *     "light":  { … },                      the same, when light
 *     "accent": { "fill": "#be123c", "ink", "scale", "alt",
 *                 "dark": { "text", … }, "light": { … } },
 *     "extras": { "mode", "spacing", "corners", "blur", "solidPanels" }
 *   }
 *
 * Every part is optional; omitted parts come from the look it's applied to.
 * Colour names are those of src/utils/theme/palette.ts (Neutrals) and
 * colour.ts (AccentColours); docs/seerr-ai/themes.md lists them for hand
 * authors.
 */
import type { Appearance, ThemeMode } from '@server/constants/theme';
import {
  THEME_CORNERS,
  THEME_MODES,
  THEME_SPACINGS,
  cleanHexColour,
} from '@server/constants/theme';

/** The format version this server reads. */
export const THEME_FILE_VERSION = 1;

/** Max theme file size as JSON. An exported one is about 5 KB. */
export const THEME_FILE_MAX_BYTES = 16 * 1024;

/** Max name or author length. */
export const THEME_FILE_NAME_MAX = 60;

export const THEME_FILE_STEPS = [
  '50',
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
  '950',
] as const;
type Step = (typeof THEME_FILE_STEPS)[number];

/** Page colours in one mode (palette.ts's Neutrals). */
export const THEME_FILE_NEUTRALS = [
  'page',
  'surface',
  'surfaceRaised',
  'sidebar',
  'sidebarTo',
  'overlay',
  'overlayStrong',
  'mediaScrim',
  'textStrong',
  'textDefault',
  'textMuted',
  'borderSubtle',
  'borderStrong',
  'field',
  'fieldBorder',
] as const;
export type ThemeFileNeutral = (typeof THEME_FILE_NEUTRALS)[number];

/** Accent colours in one mode (colour.ts's AccentModeColours). */
export const THEME_FILE_ACCENT_MODE = [
  'hover',
  'text',
  'soft',
  'alt',
  'altHover',
  'chip',
  'onChip',
] as const;
export type ThemeFileAccentModeKey = (typeof THEME_FILE_ACCENT_MODE)[number];

export type ThemeFileScale = Partial<Record<Step, string>>;

export type ThemeFileMode = Partial<Record<ThemeFileNeutral, string>> & {
  /** The grey scale, used by pages without their own colours yet. */
  gray?: ThemeFileScale;
};

export interface ThemeFileAccent {
  /** Buttons and switches; the other colours derive from it. */
  fill?: string;
  /** Text on the fill. */
  ink?: string;
  scale?: ThemeFileScale;
  /** The gradient partner's scale. */
  alt?: ThemeFileScale;
  dark?: Partial<Record<ThemeFileAccentModeKey, string>>;
  light?: Partial<Record<ThemeFileAccentModeKey, string>>;
}

/** Settings a file can carry, applied on import. */
export type ThemeFileExtras = Partial<
  Pick<Appearance, 'mode' | 'spacing' | 'corners' | 'blur' | 'solidPanels'>
>;

export interface ThemeFile {
  seerrTheme: typeof THEME_FILE_VERSION;
  name: string;
  author?: string;
  dark?: ThemeFileMode;
  light?: ThemeFileMode;
  accent?: ThemeFileAccent;
  extras?: ThemeFileExtras;
}

/** Why a file can't be used, for the importer. */
export type ThemeFileProblem =
  | { problem: 'tooLarge' | 'notJson' | 'notThemeFile' | 'newerVersion' }
  | { problem: 'name' }
  | { problem: 'unknownKey' | 'notColour' | 'notValue'; key: string };

type Checked<T> = { value: T } | ThemeFileProblem;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const byteLength = (text: string): number =>
  new TextEncoder().encode(text).length;

/** Control characters and line breaks, never needed in a name. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A name or author: plain single-line text within the length limit. */
const cleanLabel = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const label = value.trim();
  const plain = !CONTROL_CHARACTERS.test(label);
  return label && plain && label.length <= THEME_FILE_NAME_MAX
    ? label
    : undefined;
};

/** An object of colours whose keys are all in `keys`. */
const checkColours = <K extends string>(
  value: unknown,
  keys: readonly K[],
  path: string
): Checked<Partial<Record<K, string>>> => {
  if (!isRecord(value)) {
    return { problem: 'notValue', key: path };
  }
  const colours: Partial<Record<K, string>> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!keys.includes(key as K)) {
      return { problem: 'unknownKey', key: `${path}.${key}` };
    }
    const colour = cleanHexColour(raw);
    if (!colour) {
      return { problem: 'notColour', key: `${path}.${key}` };
    }
    colours[key as K] = colour;
  }
  return { value: colours };
};

const checkMode = (value: unknown, path: string): Checked<ThemeFileMode> => {
  if (!isRecord(value)) {
    return { problem: 'notValue', key: path };
  }
  const { gray, ...colours } = value;
  const neutrals = checkColours(colours, THEME_FILE_NEUTRALS, path);
  if (!('value' in neutrals)) {
    return neutrals;
  }
  if (!Object.hasOwn(value, 'gray')) {
    return neutrals;
  }
  const scale = checkColours(gray, THEME_FILE_STEPS, `${path}.gray`);
  return 'value' in scale
    ? { value: { ...neutrals.value, gray: scale.value } }
    : scale;
};

const checkAccent = (value: unknown): Checked<ThemeFileAccent> => {
  if (!isRecord(value)) {
    return { problem: 'notValue', key: 'accent' };
  }
  const accent: ThemeFileAccent = {};
  for (const [key, raw] of Object.entries(value)) {
    const path = `accent.${key}`;
    let checked: Checked<unknown>;
    if (key === 'fill' || key === 'ink') {
      const colour = cleanHexColour(raw);
      checked = colour
        ? { value: colour }
        : { problem: 'notColour', key: path };
    } else if (key === 'scale' || key === 'alt') {
      checked = checkColours(raw, THEME_FILE_STEPS, path);
    } else if (key === 'dark' || key === 'light') {
      checked = checkColours(raw, THEME_FILE_ACCENT_MODE, path);
    } else {
      return { problem: 'unknownKey', key: path };
    }
    if (!('value' in checked)) {
      return checked;
    }
    (accent as Record<string, unknown>)[key] = checked.value;
  }
  return { value: accent };
};

const EXTRA_VALUES: Record<keyof ThemeFileExtras, (value: unknown) => boolean> =
  {
    mode: (value) => THEME_MODES.includes(value as ThemeMode),
    spacing: (value) =>
      THEME_SPACINGS.includes(value as (typeof THEME_SPACINGS)[number]),
    corners: (value) =>
      THEME_CORNERS.includes(value as (typeof THEME_CORNERS)[number]),
    blur: (value) => typeof value === 'boolean',
    solidPanels: (value) => typeof value === 'boolean',
  };

const checkExtras = (value: unknown): Checked<ThemeFileExtras> => {
  if (!isRecord(value)) {
    return { problem: 'notValue', key: 'extras' };
  }
  for (const [key, raw] of Object.entries(value)) {
    const valid = Object.hasOwn(EXTRA_VALUES, key)
      ? EXTRA_VALUES[key as keyof ThemeFileExtras]
      : undefined;
    if (!valid) {
      return { problem: 'unknownKey', key: `extras.${key}` };
    }
    if (!valid(raw)) {
      return { problem: 'notValue', key: `extras.${key}` };
    }
  }
  return { value: { ...value } as ThemeFileExtras };
};

const TOP_KEYS = [
  'seerrTheme',
  'name',
  'author',
  'dark',
  'light',
  'accent',
  'extras',
];

/**
 * A theme file as stored, or its problem. Strict: an unknown key or invalid
 * value fails the whole file rather than being skipped.
 */
export const checkThemeFile = (
  value: unknown
): { theme: ThemeFile } | ThemeFileProblem => {
  if (!isRecord(value) || !Object.hasOwn(value, 'seerrTheme')) {
    return { problem: 'notThemeFile' };
  }
  let size: number;
  try {
    size = byteLength(JSON.stringify(value));
  } catch {
    return { problem: 'notThemeFile' };
  }
  if (size > THEME_FILE_MAX_BYTES) {
    return { problem: 'tooLarge' };
  }
  if (value.seerrTheme !== THEME_FILE_VERSION) {
    return typeof value.seerrTheme === 'number' &&
      value.seerrTheme > THEME_FILE_VERSION
      ? { problem: 'newerVersion' }
      : { problem: 'notThemeFile' };
  }
  const unknown = Object.keys(value).find((key) => !TOP_KEYS.includes(key));
  if (unknown !== undefined) {
    return { problem: 'unknownKey', key: unknown };
  }
  const name = cleanLabel(value.name);
  if (!name) {
    return { problem: 'name' };
  }
  const theme: ThemeFile = { seerrTheme: THEME_FILE_VERSION, name };
  if (value.author !== undefined) {
    const author = cleanLabel(value.author);
    if (!author) {
      return { problem: 'notValue', key: 'author' };
    }
    theme.author = author;
  }
  const parts = {
    dark: () => checkMode(value.dark, 'dark'),
    light: () => checkMode(value.light, 'light'),
    accent: () => checkAccent(value.accent),
    extras: () => checkExtras(value.extras),
  };
  for (const [key, check] of Object.entries(parts)) {
    if (value[key] === undefined) {
      continue;
    }
    const checked = check();
    if (!('value' in checked)) {
      return checked;
    }
    (theme as unknown as Record<string, unknown>)[key] = checked.value;
  }
  return { theme };
};

/** A theme file as stored, or undefined if unusable. */
export const cleanThemeFile = (value: unknown): ThemeFile | undefined => {
  const checked = checkThemeFile(value);
  return 'theme' in checked ? checked.theme : undefined;
};

/** Parses a theme file from the chosen file's text. */
export const readThemeFile = (
  text: string
): { theme: ThemeFile } | ThemeFileProblem => {
  if (byteLength(text) > THEME_FILE_MAX_BYTES) {
    return { problem: 'tooLarge' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: 'notJson' };
  }
  return checkThemeFile(value);
};

/**
 * A look without its theme file: what safe mode shows, and the on-device copy
 * (a cookie, which must stay small).
 */
export const withoutThemeFile = <T extends { theme?: ThemeFile }>(
  look: T
): Omit<T, 'theme'> => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { theme, ...rest } = look;
  return rest;
};
