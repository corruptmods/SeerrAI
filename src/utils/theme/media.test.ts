import type { Appearance } from '@server/constants/theme';
import {
  appearanceFromDefaults,
  SERVER_THEME_DEFAULTS,
  THEME_BACKGROUNDS,
} from '@server/constants/theme';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { contrastRatio } from './colour';
import type { ShownMode } from './index';
import { themeAttributes, themeVariables } from './index';
import { LIGHT } from './palette';

/* Image fades (title pages, posters, sign-in slideshow) and logos in every look. */

const root = path.join(__dirname, '../../..');
const css = readFileSync(path.join(root, 'src/styles/globals.css'), 'utf8');

const classic = appearanceFromDefaults(SERVER_THEME_DEFAULTS);
const look = (changes: Partial<Appearance>): Appearance => ({
  ...classic,
  ...changes,
});

/** Custom properties set by the globals.css rule starting at `at`. */
const propertiesAt = (at: number): Record<string, string> =>
  Object.fromEntries(
    [
      ...css
        .slice(at, css.indexOf('}', at))
        .matchAll(/--([\w-]+):\s*([^;]+);/g),
    ].map((m) => [m[1], m[2]])
  );

/** Custom properties set by the rule with exactly this selector. */
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `globals.css has ${selector}`);
  return propertiesAt(at);
};

/** The :root rule holding the fades (globals.css has several). */
const fadeRoot = () => {
  const at = css.indexOf(':root {\n  --title-fade');
  assert.ok(at >= 0, 'globals.css has the fades');
  return propertiesAt(at);
};

/**
 * Resolved fade variables for a look: matching globals.css rules, with var()
 * resolved against the look's colours.
 */
const fades = (appearance: Appearance, mode: ShownMode) => {
  const theme = themeAttributes(appearance)['data-theme'];
  const values = fadeRoot();
  if (mode === 'dark' && theme !== 'classic') {
    Object.assign(
      values,
      rule(":root[data-mode='dark']:not([data-theme='classic'])")
    );
  }
  if (mode === 'light') {
    Object.assign(values, rule(":root[data-mode='light']"));
  }
  const colours = themeVariables(appearance, mode);
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      value.replace(/^var\(--([\w-]+)\)$/, (_, other) => colours[other]),
    ])
  );
};

const hex = (channels: string) =>
  `#${channels
    .split(' ')
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('')}`;

/** Composites a colour over another at an opacity. */
const over = (top: string, alpha: number, under: string) =>
  `#${[1, 3, 5]
    .map((i) =>
      Math.round(
        parseInt(top.slice(i, i + 2), 16) * alpha +
          parseInt(under.slice(i, i + 2), 16) * (1 - alpha)
      )
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;

describe('the fades over pictures', () => {
  it('are today’s colours in Classic dark', () => {
    const values = fades(classic, 'dark');
    const page = themeVariables(classic, 'dark').page;
    // Title backdrop: rgba(17, 24, 39, 0.47) into the page.
    assert.equal(page, '17 24 39');
    assert.equal(values['title-fade'], '0.47');
    // Hovered poster: rgba(45, 55, 72).
    assert.equal(values['card-scrim'], '45 55 72');
    // Collection banner and genre cards: rgb(31, 41, 55).
    assert.equal(values['media-scrim-raised'], '31 41 55');
    // Sign-in slideshow: rgba(45, 55, 72, 0.47) into #1a202e.
    assert.equal(values['backdrop-fade-from'], '45 55 72');
    assert.equal(values['backdrop-fade-to'], '26 32 46');
    assert.equal(values['backdrop-fade-start'], '0.47');
  });

  it('use each dark background’s own greys, not Classic’s blue', () => {
    for (const background of THEME_BACKGROUNDS.filter((b) => b !== 'classic')) {
      const appearance = look({ background });
      const values = fades(appearance, 'dark');
      const colours = themeVariables(appearance, 'dark');
      assert.equal(values['card-scrim'], colours.surface, background);
      assert.equal(values['media-scrim-raised'], colours.surface, background);
      assert.equal(values['backdrop-fade-from'], colours.surface, background);
      assert.equal(values['backdrop-fade-to'], colours.page, background);
    }
  });

  it('keep light text readable on posters and banners in every look', () => {
    for (const background of THEME_BACKGROUNDS) {
      for (const mode of ['dark', 'light'] as const) {
        const appearance = look({ background });
        const values = fades(appearance, mode);
        const onMedia = hex(themeVariables(appearance, mode)['on-media']);
        for (const scrim of ['card-scrim', 'media-scrim-raised']) {
          assert.ok(
            contrastRatio(onMedia, hex(values[scrim])) >= 7,
            `${background} ${mode} ${scrim}`
          );
        }
      }
    }
  });

  it('cover the picture behind a row more off Classic, and most in light', () => {
    assert.equal(fades(classic, 'dark')['row-fade'], '0.47');
    assert.equal(
      rule(
        ":root[data-mode='dark']:is(:not([data-theme='classic']), [data-season])"
      )['row-fade'],
      '0.6'
    );
    assert.equal(fades(look({ mode: 'light' }), 'light')['row-fade'], '0.85');
  });

  it('let dark text be read over a title page’s backdrop in light', () => {
    const appearance = look({ mode: 'light' });
    const values = fades(appearance, 'light');
    const alpha = Number(values['title-fade']);
    // Over a black image the page top still reads for title, details and hints.
    const top = over(LIGHT.page, alpha, '#000000');
    assert.ok(contrastRatio(LIGHT.textStrong, top) >= 7, top);
    assert.ok(contrastRatio(LIGHT.textDefault, top) >= 4.5, top);
    assert.ok(contrastRatio(LIGHT.textMuted, top) >= 4.5, top);
    // The sign-in slideshow fades into the light page too.
    assert.equal(hex(values['backdrop-fade-to']), LIGHT.page);
  });

  it('let dark text be read over the sign-in page’s slideshow in light', () => {
    const values = fades(look({ mode: 'light' }), 'light');
    // Heading and the muted language icon, over a black image.
    const top = over(
      hex(values['backdrop-fade-from']),
      Number(values['backdrop-fade-start']),
      '#000000'
    );
    assert.ok(contrastRatio(LIGHT.textStrong, top) >= 7, top);
    assert.ok(contrastRatio(LIGHT.textMuted, top) >= 3, top);
  });
});

describe('the stacked logo', () => {
  const read = (name: string) =>
    readFileSync(path.join(root, 'public', name), 'utf8');

  it('has a light-mode copy with a dark wordmark, otherwise the same', () => {
    const dark = read('logo_stacked_ai.svg');
    const light = read('logo_stacked_ai_light.svg');
    assert.ok(dark.includes('fill="white"'));
    assert.ok(!light.includes('fill="white"'));
    assert.equal(light.replaceAll('fill="#111827"', 'fill="white"'), dark);
    assert.ok(contrastRatio('#111827', LIGHT.page) >= 7);
  });
});
