/*
 * Theme files on the page (the format is in server/constants/themeFile.ts):
 * exporting what someone has as a file, importing one into a look, and the
 * built-in gallery. Their colours are put in place by themeFileColours.ts.
 */
import type {
  Appearance,
  ThemeDefaults,
  ThemeMode,
} from '@server/constants/theme';
import type { ThemeFile, ThemeFileMode } from '@server/constants/themeFile';
import {
  THEME_FILE_ACCENT_MODE,
  THEME_FILE_NEUTRALS,
  THEME_FILE_VERSION,
} from '@server/constants/themeFile';
import type { Scale } from './colour';
import { SCALE_STEPS, contrastRatio } from './colour';
import { accentColours, neutralsFor } from './index';

const scaleOf = (scale: Scale) =>
  Object.fromEntries(SCALE_STEPS.map((step) => [String(step), scale[step]]));

/**
 * What someone has, as a theme file: every colour in light and dark, so
 * importing it gives exactly this look back, and the extras that go with
 * it. A theme file in use keeps its name and author.
 */
export const exportThemeFile = (
  appearance: Appearance,
  name: string
): ThemeFile => {
  const accent = accentColours(appearance);
  const mode = (shown: 'dark' | 'light'): ThemeFileMode => {
    const neutrals = neutralsFor(appearance, shown);
    return {
      ...Object.fromEntries(
        THEME_FILE_NEUTRALS.map((key) => [key, neutrals[key]])
      ),
      gray: scaleOf(neutrals.gray),
    };
  };
  const accentMode = (shown: 'dark' | 'light') =>
    Object.fromEntries(
      THEME_FILE_ACCENT_MODE.map((key) => [key, accent[shown][key]])
    );
  return {
    seerrTheme: THEME_FILE_VERSION,
    name: appearance.theme?.name ?? name,
    ...(appearance.theme?.author && { author: appearance.theme.author }),
    dark: mode('dark'),
    light: mode('light'),
    accent: {
      fill: accent.fill,
      ink: accent.ink,
      scale: scaleOf(accent.scale),
      alt: scaleOf(accent.alt),
      dark: accentMode('dark'),
      light: accentMode('light'),
    },
    extras: {
      mode: appearance.mode,
      spacing: appearance.spacing,
      corners: appearance.corners,
      blur: appearance.blur,
      solidPanels: appearance.solidPanels,
    },
  };
};

const EXTRAS = ['spacing', 'corners', 'blur', 'solidPanels'] as const;

/**
 * A look with a theme file imported: the file's colours, and the mode and
 * extras it brings; whatever it leaves out stays as the person had it. Its
 * fill becomes the custom accent too, which is what the sign-in page and
 * safe mode show, as they leave theme files out.
 */
export const appearanceWithThemeFile = <T extends ThemeDefaults>(
  look: T,
  theme: ThemeFile
): T => {
  const next: T = { ...look, theme };
  const extras = theme.extras ?? {};
  if (extras.mode) {
    next.mode = extras.mode;
  }
  for (const key of EXTRAS) {
    if (key in look && extras[key] !== undefined) {
      (next as unknown as Record<string, unknown>)[key] = extras[key];
    }
  }
  if (theme.accent?.fill) {
    next.accent = 'custom';
    next.customAccent = theme.accent.fill;
  }
  return next;
};

const modesOf = (mode: ThemeMode): ('dark' | 'light')[] =>
  mode === 'auto' ? ['dark', 'light'] : [mode];

/**
 * Text in a theme file's colours that would be hard to read (under 4.5:1),
 * as "mode:name". Only pairs the file has a hand in are counted: built-in
 * colours are checked by their own tests.
 */
export const hardToRead = (appearance: Appearance): string[] => {
  const file = appearance.theme;
  if (!file) {
    return [];
  }
  const accent = accentColours(appearance);
  const problems: string[] = [];
  for (const mode of modesOf(appearance.mode)) {
    const part = file[mode] ?? {};
    const n = neutralsFor(appearance, mode);
    const backgroundsSet =
      part.page !== undefined || part.surface !== undefined;
    const pairs: [string, string, boolean][] = [
      ['textStrong', n.textStrong, !!part.textStrong],
      ['textDefault', n.textDefault, !!part.textDefault],
      ['textMuted', n.textMuted, !!part.textMuted],
      ['accentText', accent[mode].text, !!file.accent?.[mode]?.text],
    ];
    for (const [name, text, set] of pairs) {
      if (
        (set || backgroundsSet) &&
        [n.page, n.surface].some(
          (background) => contrastRatio(text, background) < 4.5
        )
      ) {
        problems.push(`${mode}:${name}`);
      }
    }
    if (
      (file.accent?.ink || file.accent?.fill) &&
      contrastRatio(accent.ink, accent.fill) < 4.5
    ) {
      problems.push(`${mode}:ink`);
    }
  }
  return problems;
};

/** The built-in looks offered on the Appearance page. */
export const THEME_GALLERY: {
  id: 'classic' | 'midnight' | 'daylight' | 'ember';
  look: Partial<ThemeDefaults>;
}[] = [
  // How Seerr AI has always looked.
  {
    id: 'classic',
    look: { mode: 'dark', accent: 'indigo', background: 'classic' },
  },
  {
    id: 'midnight',
    look: { mode: 'dark', accent: 'teal', background: 'black' },
  },
  // Light leaves the dark background as it was.
  { id: 'daylight', look: { mode: 'light', accent: 'indigo' } },
  { id: 'ember', look: { mode: 'dark', accent: 'rose', background: 'warm' } },
];

/** The gallery's look a look is, if any; never one with a theme file. */
export const galleryLookIn = (
  appearance: ThemeDefaults
): (typeof THEME_GALLERY)[number] | undefined =>
  appearance.theme
    ? undefined
    : THEME_GALLERY.find((entry) =>
        Object.entries(entry.look).every(
          ([key, value]) => appearance[key as keyof ThemeDefaults] === value
        )
      );
