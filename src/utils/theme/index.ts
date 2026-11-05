/*
 * Renders a look onto the page.
 *
 * Semantic colours (bg-page, text-strong, bg-accent, …; tailwind.config.js)
 * and gray-* / indigo-* all read CSS variables. A look is those variables as
 * one stylesheet per mode, plus attributes on <html>:
 *
 *   data-mode="dark|light"      the mode showing now
 *   data-mode-choice            dark, light or auto ("Match my device")
 *   data-theme="classic|…"      the dark background
 *   data-accent="indigo|…"      the accent
 *   data-spacing, data-corners, data-blur, data-solid
 *                               extras, only when non-default
 *   data-season="halloween|…"   a seasonal overlay, while one shows
 *
 * The server writes both (pages/_document); THEME_SCRIPT resolves "Match my
 * device" before first paint and follows the device afterwards.
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

/** The accent's colours; theme file colours override where given. */
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
 * Text for the active-page count badge on the accent's 700→partner-700
 * gradient: the palest shade where it reads, else white (e.g. Amber).
 */
const deepInk = ({ scale, alt }: AccentColours) => {
  const worst = (hex: string) =>
    Math.min(contrastRatio(hex, scale[700]), contrastRatio(hex, alt[700]));
  return worst(scale[100]) >= 4.5 ? scale[100] : '#ffffff';
};

/** "r g b", as Tailwind's rgb(var(--x) / <alpha-value>) needs. */
const channels = (hex: string) => hexToRgb(hex).join(' ');

/**
 * Every variable for one mode, keyed without "--": numbers for opacities,
 * "r g b" for colours. A season supplies its accent, night background and
 * --season-mark.
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
  // Classic keeps the original status colours; other dark backgrounds have their own.
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
  // Opacity of fills, panels and phone bars. Light mode is solid: white text
  // keeps contrast and white panels over the dim page don't turn grey.
  // Accent fills are solid with dark ink, which a dark page behind would
  // make unreadable.
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

/** Modes a look can show: both for "Match my device". */
const modesOf = (mode: ThemeMode): ShownMode[] =>
  mode === 'auto' ? ['dark', 'light'] : [mode];

/** A look's stylesheet: its variables under each mode it uses. */
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

/** A look's <html> attributes. */
export const themeAttributes = (
  appearance: Appearance,
  season?: SeasonId
): Record<string, string> => ({
  // "Match my device" is dark until THEME_SCRIPT asks the device.
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

/** Every attribute a look can set, so a change can clear old ones. */
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

/** The theme-color meta (top bar and sidebar colour) for each mode a look can show. */
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
 * The look a page shows: the user's, else the device's copy when signed
 * out, else the server default.
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

/** Id of the server-written theme <style>. */
export const THEME_STYLE_ID = 'seerr-theme';

/*
 * Runs before first paint (pages/_document). For "Match my device", shows
 * the device's mode and follows its changes.
 */
export const THEME_SCRIPT =
  "(function(){try{var d=document.documentElement,q=window.matchMedia('(prefers-color-scheme: light)'),f=function(){if(d.getAttribute('data-mode-choice')==='auto'){d.setAttribute('data-mode',q.matches?'light':'dark')}};f();q.addEventListener?q.addEventListener('change',f):q.addListener(f)}catch(e){}})()";

/** The mode "Match my device" shows now. */
export const deviceMode = (): ShownMode =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';

/**
 * Applies a look (and any season) to the page now. `remember` stores it on
 * the device for the sign-in page; `forget` removes that copy.
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
