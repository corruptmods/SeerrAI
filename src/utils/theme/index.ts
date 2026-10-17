/*
 * What a look turns into on the page.
 *
 * Components use semantic colours (bg-page, text-strong, bg-accent, …, set
 * up in tailwind.config.js), and gray-* and indigo-* still work for anything
 * not yet given one; every one of them reads a CSS variable. A look is the
 * values of those variables, written as a small stylesheet for each mode it
 * uses, plus attributes on <html>:
 *
 *   data-mode="dark|light"      what is showing now
 *   data-mode-choice            dark, light or auto ("Match my device")
 *   data-theme="classic|…"      the dark background
 *   data-accent="indigo|…"      the accent
 *   data-spacing, data-corners, data-blur, data-solid
 *                               the extras, only when not the usual
 *   data-season="halloween|…"   a seasonal theme on top, while one shows
 *
 * The server writes both into the page (pages/_document), so it arrives
 * looking right; THEME_SCRIPT then picks light or dark for "Match my
 * device" before anything is drawn, and follows the device from then on.
 */
import type {
  Appearance,
  ThemeDefaults,
  ThemeMode,
} from '@server/constants/theme';
import {
  THEME_COOKIE,
  appearanceCookieValue,
  appearanceFromDefaults,
} from '@server/constants/theme';
import type { SeasonId } from '@server/lib/seasons';
import type { AccentColours, ScaleStep } from './colour';
import {
  SCALE_STEPS,
  accentFromColour,
  contrastRatio,
  hexToRgb,
} from './colour';
import type { Neutrals, Status } from './palette';
import {
  ACCENTS,
  CUSTOM_ACCENT_START,
  DARK_BACKGROUNDS,
  LIGHT,
  OTHER_DARK_STATUS,
  STATUS,
} from './palette';
import { SEASON_LOOKS } from './seasons';
import { accentWithThemeFile, neutralsWithThemeFile } from './themeFileColours';

export type ShownMode = 'dark' | 'light';

/**
 * The accent's colours; a custom one is made from its colour, and a theme
 * file's take their place where it gives them.
 */
export const accentColours = (
  appearance: Pick<Appearance, 'accent' | 'customAccent' | 'theme'>
): AccentColours =>
  accentWithThemeFile(
    appearance.accent === 'custom'
      ? accentFromColour(appearance.customAccent ?? CUSTOM_ACCENT_START)
      : ACCENTS[appearance.accent],
    appearance.theme?.accent
  );

export const neutralsFor = (
  appearance: Pick<Appearance, 'background' | 'theme'>,
  mode: ShownMode
): Neutrals =>
  neutralsWithThemeFile(
    mode === 'light' ? LIGHT : DARK_BACKGROUNDS[appearance.background],
    appearance.theme?.[mode]
  );

/*
 * The text of the count beside the page you are on (sidebar and the phone's
 * bar), on the accent's deep gradient: its 700 into its partner's 700. The
 * accent's palest shade where that reads, as Indigo's always has, and
 * white where it doesn't (Amber's partner is too light for its pale
 * shades).
 */
const deepInk = ({ scale, alt }: AccentColours) => {
  const worst = (hex: string) =>
    Math.min(contrastRatio(hex, scale[700]), contrastRatio(hex, alt[700]));
  return worst(scale[100]) >= 4.5 ? scale[100] : '#ffffff';
};

/** "r g b", as Tailwind's rgb(var(--x) / <alpha-value>) needs. */
const channels = (hex: string) => hexToRgb(hex).join(' ');

/**
 * Every variable for one mode, by name without the leading "--". Numbers
 * for the opacities, "r g b" for the colours. A season on top brings its
 * accent, its night in place of the dark background, and its mark's
 * colour (--season-mark).
 */
export const themeVariables = (
  appearance: Appearance,
  mode: ShownMode,
  season?: SeasonId
): Record<string, string> => {
  const seasonal = season ? SEASON_LOOKS[season] : undefined;
  const n =
    seasonal && mode === 'dark'
      ? seasonal.night
      : neutralsFor(appearance, mode);
  const accent = seasonal?.accent ?? accentColours(appearance);
  const forMode = accent[mode];
  const vars: Record<string, string> = {};
  for (const step of SCALE_STEPS) {
    vars[`gray-${step}`] = channels(n.gray[step]);
  }
  for (const step of SCALE_STEPS) {
    vars[`accent-${step}`] = channels(accent.scale[step as ScaleStep]);
  }
  for (const step of SCALE_STEPS) {
    vars[`accent-alt-${step}`] = channels(accent.alt[step as ScaleStep]);
  }
  Object.assign(vars, {
    page: channels(n.page),
    surface: channels(n.surface),
    'surface-raised': channels(n.surfaceRaised),
    sidebar: channels(n.sidebar),
    'sidebar-to': channels(n.sidebarTo),
    overlay: channels(n.overlay),
    'overlay-strong': channels(n.overlayStrong),
    'media-scrim': channels(n.mediaScrim),
    'text-strong': channels(n.textStrong),
    'text-default': channels(n.textDefault),
    'text-muted': channels(n.textMuted),
    'on-accent': channels(accent.ink),
    'on-media': '255 255 255',
    'border-subtle': channels(n.borderSubtle),
    'border-strong': channels(n.borderStrong),
    field: channels(n.field),
    'field-border': channels(n.fieldBorder),
    accent: channels(accent.fill),
    'accent-hover': channels(forMode.hover),
    'accent-text': channels(forMode.text),
    'accent-soft': channels(forMode.soft),
    'accent-alt': channels(forMode.alt),
    'accent-alt-hover': channels(forMode.altHover),
    'accent-chip': channels(forMode.chip),
    'on-accent-chip': channels(forMode.onChip),
    'on-accent-deep': channels(deepInk(accent)),
  });
  // Classic's page keeps today's status colours; every other dark one (True
  // black, Slate, Warm, a season's night, a theme file's) has its own.
  const statuses =
    mode === 'dark' && n.page !== DARK_BACKGROUNDS.classic.page
      ? OTHER_DARK_STATUS
      : STATUS[mode];
  for (const status of ['success', 'warning', 'danger', 'info'] as Status[]) {
    const colours = statuses[status];
    vars[status] = channels(colours.fill);
    vars[`${status}-text`] = channels(colours.text);
    vars[`${status}-soft`] = channels(colours.soft);
  }
  // How see-through fills (buttons, badges), panels (menus, slide-overs,
  // the top bar once scrolled) and the phone's bars are. Light mode's fills
  // are solid so white text keeps its contrast, and so are its panels: a
  // white panel over the dimmed page turns grey and loses its dividers.
  // "Reduce see-through panels" makes everything solid. The accent's own
  // fills are solid too when its button text is dark: see-through over a
  // dark page, a bright fill turns too dark for that text.
  const solid = appearance.solidPanels;
  vars['fill-opacity'] = solid || mode === 'light' ? '1' : '0.8';
  vars['accent-fill-opacity'] =
    solid || mode === 'light' || accent.inkIsDark ? '1' : '0.8';
  vars['panel-opacity'] = solid || mode === 'light' ? '1' : '0.8';
  vars['bar-opacity'] = solid ? '1' : '0.9';
  if (seasonal) {
    vars['season-mark'] = channels(seasonal.mark[mode]);
  }
  return vars;
};

/** The modes a look can show: one, or both for "Match my device". */
const modesOf = (mode: ThemeMode): ShownMode[] =>
  mode === 'auto' ? ['dark', 'light'] : [mode];

/** The stylesheet for a look: its variables, under each mode it uses. */
export const themeCss = (appearance: Appearance, season?: SeasonId): string =>
  modesOf(appearance.mode)
    .map(
      (mode) =>
        `:root[data-mode="${mode}"]{${Object.entries(
          themeVariables(appearance, mode, season)
        )
          .map(([name, value]) => `--${name}:${value};`)
          .join('')}}`
    )
    .join('');

/** The attributes on <html> for a look. */
export const themeAttributes = (
  appearance: Appearance,
  season?: SeasonId
): Record<string, string> => ({
  // "Match my device" is drawn dark until THEME_SCRIPT has asked the device.
  'data-mode': appearance.mode === 'light' ? 'light' : 'dark',
  'data-mode-choice': appearance.mode,
  'data-theme': appearance.background,
  'data-accent': appearance.accent,
  ...(appearance.spacing !== 'comfortable' && { 'data-spacing': 'compact' }),
  ...(appearance.corners !== 'rounded' && { 'data-corners': 'square' }),
  ...(appearance.blur && { 'data-blur': 'on' }),
  ...(appearance.solidPanels && { 'data-solid': 'on' }),
  ...(season && { 'data-season': season }),
});

/** Every attribute a look can set, so a change can clear the old ones. */
const THEME_ATTRIBUTES = [
  'data-mode',
  'data-mode-choice',
  'data-theme',
  'data-accent',
  'data-spacing',
  'data-corners',
  'data-blur',
  'data-solid',
  'data-season',
];

/**
 * The colour of the browser's bar (the theme-color meta) for each mode a
 * look can show: the colour of the top bar and sidebar.
 */
export const themeColour = (
  appearance: Appearance,
  season?: SeasonId
): Partial<Record<ShownMode, string>> =>
  Object.fromEntries(
    modesOf(appearance.mode).map((mode) => [
      mode,
      season && mode === 'dark'
        ? SEASON_LOOKS[season].night.surface
        : neutralsFor(appearance, mode).surface,
    ])
  );

/**
 * Whose look a page shows: a signed-in person's own, or the server's if
 * they have not chosen; before anyone signs in, the copy kept on this
 * device, or the server's.
 */
export const chosenAppearance = ({
  signedIn,
  own,
  device,
  server,
}: {
  signedIn: boolean;
  own: Appearance | null | undefined;
  device: Appearance | undefined;
  server: ThemeDefaults;
}): Appearance => (signedIn ? own : device) ?? appearanceFromDefaults(server);

/** The id of the <style> the server writes the look into. */
export const THEME_STYLE_ID = 'seerr-theme';

/*
 * Runs in the page before anything is drawn (pages/_document). With "Match
 * my device", it shows light or dark as the device is, and switches when
 * the device does, for as long as the page is open.
 */
export const THEME_SCRIPT =
  "(function(){try{var d=document.documentElement,q=window.matchMedia('(prefers-color-scheme: light)'),f=function(){if(d.getAttribute('data-mode-choice')==='auto'){d.setAttribute('data-mode',q.matches?'light':'dark')}};f();q.addEventListener?q.addEventListener('change',f):q.addListener(f)}catch(e){}})()";

/** What "Match my device" shows right now. */
export const deviceMode = (): ShownMode =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';

/**
 * Shows a look on this page at once: its stylesheet and attributes, with a
 * season on top if one shows. With `remember`, the look is also kept on
 * the device for the sign-in page; with `forget`, the copy is removed (back
 * to the server's default).
 */
export const applyAppearance = (
  appearance: Appearance,
  keep?: 'remember' | 'forget',
  season?: SeasonId
): void => {
  const root = document.documentElement;
  let style = document.getElementById(THEME_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = THEME_STYLE_ID;
    document.head.appendChild(style);
  }
  const css = themeCss(appearance, season);
  if (style.textContent !== css) {
    style.textContent = css;
  }
  const attributes = themeAttributes(appearance, season);
  if (appearance.mode === 'auto') {
    attributes['data-mode'] = deviceMode();
  }
  for (const name of THEME_ATTRIBUTES) {
    const value = attributes[name];
    if (value === undefined) {
      root.removeAttribute(name);
    } else if (root.getAttribute(name) !== value) {
      root.setAttribute(name, value);
    }
  }
  if (keep === 'remember') {
    document.cookie = `${THEME_COOKIE}=${appearanceCookieValue(appearance)}; path=/; max-age=31536000; SameSite=Lax`;
  } else if (keep === 'forget') {
    document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  }
};
