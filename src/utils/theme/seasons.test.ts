import type { Appearance } from '@server/constants/theme';
import {
  appearanceFromDefaults,
  SERVER_THEME_DEFAULTS,
} from '@server/constants/theme';
import { SEASON_IDS } from '@server/lib/seasons';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contrastRatio } from './colour';
import {
  themeAttributes,
  themeColour,
  themeCss,
  themeVariables,
} from './index';
import { LIGHT, OTHER_DARK_STATUS, STATUS } from './palette';
import { SEASON_LOOKS } from './seasons';

/*
 * What a seasonal theme does to a look: its accent, a night-time
 * background in dark mode, and a colour for the mark by the logo, on top
 * of the person's own choices.
 */

const classic = appearanceFromDefaults(SERVER_THEME_DEFAULTS);
const look = (changes: Partial<Appearance>): Appearance => ({
  ...classic,
  ...changes,
});
const hex = (channels: string) =>
  `#${channels
    .split(' ')
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('')}`;

describe('every season', () => {
  it('has text that reads on its night-time pages and panels', () => {
    for (const id of SEASON_IDS) {
      const n = SEASON_LOOKS[id].night;
      for (const surface of [n.page, n.surface]) {
        assert.ok(contrastRatio(n.textStrong, surface) >= 7, `${id} strong`);
        assert.ok(contrastRatio(n.textDefault, surface) >= 4.5, `${id} text`);
        assert.ok(contrastRatio(n.textMuted, surface) >= 4.5, `${id} muted`);
        for (const [name, status] of Object.entries(STATUS.dark)) {
          // As in every dark background: danger and info keep today's
          // colours, which reach 3:1.
          const kept = name === 'danger' || name === 'info';
          assert.ok(
            contrastRatio(status.text, surface) >= (kept ? 3 : 4.5),
            `${id} ${name}`
          );
        }
        // On top of True black, Slate or Warm.
        for (const [name, status] of Object.entries(OTHER_DARK_STATUS)) {
          assert.ok(
            contrastRatio(status.text, surface) >= 4.5,
            `${id} ${name} over another dark background`
          );
        }
      }
      assert.ok(contrastRatio(n.borderSubtle, n.surface) >= 1.3, id);
    }
  });

  it('has an accent whose buttons, links and hovers read, dark and light', () => {
    for (const id of SEASON_IDS) {
      const { accent, night } = SEASON_LOOKS[id];
      assert.ok(contrastRatio(accent.ink, accent.fill) >= 4.5, `${id} ink`);
      for (const mode of ['dark', 'light'] as const) {
        assert.ok(
          contrastRatio(accent.ink, accent[mode].hover) >= 4.5,
          `${id} ${mode} hover`
        );
        assert.ok(
          contrastRatio(accent[mode].onChip, accent[mode].chip) >= 4.5,
          `${id} ${mode} chip`
        );
        const n = mode === 'dark' ? night : LIGHT;
        for (const surface of [n.page, n.surface]) {
          assert.ok(
            contrastRatio(accent[mode].text, surface) >= 4.5,
            `${id} ${mode} link on ${surface}`
          );
        }
      }
    }
  });

  it('has a mark that can be seen, dark and light', () => {
    for (const id of SEASON_IDS) {
      const { mark, night } = SEASON_LOOKS[id];
      assert.ok(contrastRatio(mark.dark, night.surface) >= 3, `${id} dark`);
      assert.ok(contrastRatio(mark.light, LIGHT.surface) >= 3, `${id} light`);
      assert.ok(SEASON_LOOKS[id].icon.length > 0, id);
    }
  });

  it('uses the approved colours for Halloween, Holidays and New Year', () => {
    const designed = {
      halloween: ['#f97316', '#1c1917', '#fb923c', '#c2410c', '#120d1c'],
      holidays: ['#15803d', '#ffffff', '#4ade80', '#15803d', '#0c1612'],
      newyear: ['#fbbf24', '#1c1917', '#fcd34d', '#92400e', '#0b0e1f'],
    } as const;
    for (const [id, colours] of Object.entries(designed)) {
      const { accent, night } = SEASON_LOOKS[id as keyof typeof designed];
      assert.deepEqual(
        [
          accent.fill,
          accent.ink,
          accent.dark.text,
          accent.light.text,
          night.page,
        ],
        colours,
        id
      );
    }
    // Holidays: an evergreen accent with a gold star.
    assert.equal(SEASON_LOOKS.holidays.mark.dark, '#fbbf24');
  });
});

describe('a look with a season on top', () => {
  it('takes the season’s accent and night in dark mode', () => {
    const own = look({ accent: 'teal', background: 'black' });
    const vars = themeVariables(own, 'dark', 'halloween');
    assert.equal(hex(vars.accent), '#f97316');
    assert.equal(hex(vars['on-accent']), '#1c1917');
    assert.equal(hex(vars['accent-text']), '#fb923c');
    assert.equal(hex(vars.page), '#120d1c');
    assert.equal(hex(vars.surface), '#1f1631');
    assert.equal(hex(vars['gray-900']), '#120d1c');
    assert.equal(hex(vars['season-mark']), SEASON_LOOKS.halloween.mark.dark);
  });

  it('reads over its fills as the other dark backgrounds do', () => {
    // The status colours of True black, Slate and Warm, not Classic's.
    const vars = themeVariables(classic, 'dark', 'halloween');
    assert.equal(vars.success, '21 128 61');
    assert.equal(vars['warning-text'], '234 179 8');
    // Its dark button text needs solid fills: over a dark page, a
    // see-through orange is too dark for it.
    for (const id of SEASON_IDS) {
      const darkInk = SEASON_LOOKS[id].accent.inkIsDark;
      const vars = themeVariables(classic, 'dark', id);
      assert.equal(vars['accent-fill-opacity'], darkInk ? '1' : '0.8', id);
      assert.equal(vars['fill-opacity'], '0.8', id);
    }
  });

  it('draws lines in its night as clearly as Classic does', () => {
    for (const id of SEASON_IDS) {
      const vars = themeVariables(classic, 'dark', id);
      assert.ok(
        contrastRatio(hex(vars['gray-700']), hex(vars['gray-800'])) >= 1.3,
        id
      );
    }
  });

  it('keeps light mode light, with the season’s accent', () => {
    const vars = themeVariables(look({ mode: 'light' }), 'light', 'holidays');
    assert.equal(hex(vars.page), LIGHT.page);
    assert.equal(hex(vars.surface), LIGHT.surface);
    assert.equal(hex(vars.accent), '#15803d');
    assert.equal(hex(vars['accent-text']), '#15803d');
    assert.equal(hex(vars['season-mark']), SEASON_LOOKS.holidays.mark.light);
  });

  it('keeps the person’s own extras', () => {
    const vars = themeVariables(look({ solidPanels: true }), 'dark', 'newyear');
    assert.equal(vars['panel-opacity'], '1');
  });

  it('is the person’s own look again without one', () => {
    const own = look({ accent: 'rose' });
    assert.deepEqual(
      themeVariables(own, 'dark', undefined),
      themeVariables(own, 'dark')
    );
    assert.equal(themeVariables(own, 'dark')['season-mark'], undefined);
  });

  it('is named on <html>', () => {
    assert.deepEqual(themeAttributes(classic, 'diwali'), {
      ...themeAttributes(classic),
      'data-season': 'diwali',
    });
    assert.equal(themeAttributes(classic)['data-season'], undefined);
  });

  it('is in the stylesheet for each mode in use, as variables only', () => {
    const css = themeCss(look({ mode: 'auto' }), 'pride');
    assert.match(css, /data-mode="dark"\]\{[^}]*--season-mark:/);
    assert.match(css, /data-mode="light"\]\{[^}]*--season-mark:/);
    assert.match(
      css,
      /^(:root\[data-mode="(dark|light)"\]\{(--[\w-]+:[\d. ]+;)+\})+$/
    );
  });

  it('colours the browser’s bar as its night', () => {
    assert.deepEqual(themeColour(look({ mode: 'auto' }), 'halloween'), {
      dark: '#1f1631',
      light: '#ffffff',
    });
  });
});
