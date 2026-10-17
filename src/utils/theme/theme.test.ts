import type { Appearance } from '@server/constants/theme';
import {
  appearanceFromDefaults,
  SERVER_THEME_DEFAULTS,
  THEME_ACCENTS,
  THEME_BACKGROUNDS,
} from '@server/constants/theme';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { contrastRatio } from './colour';
import {
  accentColours,
  chosenAppearance,
  themeAttributes,
  themeColour,
  themeCss,
  themeVariables,
} from './index';
import { ACCENTS, DARK_BACKGROUNDS, LIGHT, STATUS } from './palette';

/*
 * What each choice of look turns into on the page: the colours behind the
 * tokens, the attributes on <html>, and the colour of the browser's bar.
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

describe('Classic dark with Indigo', () => {
  it('is today’s colours, value for value', () => {
    const vars = themeVariables(classic, 'dark');
    assert.equal(vars['gray-900'], '17 24 39');
    assert.equal(vars['gray-800'], '31 41 55');
    assert.equal(vars['accent-600'], '79 70 229');
    assert.equal(vars['accent-alt-600'], '147 51 234');
    assert.equal(vars.page, '17 24 39');
    assert.equal(vars.surface, '31 41 55');
    assert.equal(vars['text-strong'], '255 255 255');
    assert.equal(vars.accent, '79 70 229');
    assert.equal(vars['accent-hover'], '99 102 241');
    assert.equal(vars['accent-text'], '99 102 241');
    assert.equal(vars['on-accent'], '255 255 255');
    assert.equal(vars['fill-opacity'], '0.8');
    assert.equal(vars['panel-opacity'], '0.8');
    assert.equal(vars['bar-opacity'], '0.9');
    assert.equal(vars['accent-chip'], '99 102 241');
    assert.equal(vars['on-accent-chip'], '224 231 255');
  });

  it('is what the stylesheet falls back to before any theme is applied', () => {
    const css = readFileSync(
      path.join(__dirname, '../../styles/globals.css'),
      'utf8'
    );
    const block = css.match(/:root \{([^}]*)\}/)?.[1] ?? '';
    const fallback = Object.fromEntries(
      [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]])
    );
    assert.deepEqual(fallback, themeVariables(classic, 'dark'));
  });

  it('has nothing extra on <html> beyond its mode, background and accent', () => {
    assert.deepEqual(themeAttributes(classic), {
      'data-mode': 'dark',
      'data-mode-choice': 'dark',
      'data-theme': 'classic',
      'data-accent': 'indigo',
    });
  });

  it('leaves title pages unblurred unless blur is chosen', () => {
    const css = readFileSync(
      path.join(__dirname, '../../styles/globals.css'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const blurred = [
      ...css.matchAll(/([^{}]*)\{[^{}]*filter:\s*blur\(var\(--title-blur\)\)/g),
    ].map((m) => m[1].trim());
    assert.deepEqual(blurred, [
      ":root[data-blur='on'] .media-page-bg-image img",
    ]);
    assert.equal(themeAttributes(classic)['data-blur'], undefined);
  });

  it('keeps the browser bar its usual colour', () => {
    assert.deepEqual(themeColour(classic), { dark: '#1f2937' });
  });
});

describe('every built-in look', () => {
  const surfacesOf = (mode: 'dark' | 'light') =>
    mode === 'light'
      ? [LIGHT]
      : THEME_BACKGROUNDS.map((background) => DARK_BACKGROUNDS[background]);

  it('has text that reads on every page and panel', () => {
    for (const mode of ['dark', 'light'] as const) {
      for (const n of surfacesOf(mode)) {
        for (const surface of [n.page, n.surface]) {
          assert.ok(contrastRatio(n.textStrong, surface) >= 7, surface);
          assert.ok(contrastRatio(n.textDefault, surface) >= 4.5, surface);
          assert.ok(contrastRatio(n.textMuted, surface) >= 4.5, surface);
          for (const [name, status] of Object.entries(STATUS[mode])) {
            // Dark keeps today's danger and info text (red-500, indigo-500),
            // which reach 3:1, enough for icons and large text, so that
            // Classic does not change.
            const kept =
              mode === 'dark' && (name === 'danger' || name === 'info');
            assert.ok(
              contrastRatio(status.text, surface) >= (kept ? 3 : 4.5),
              `${mode} ${name} on ${surface}`
            );
          }
        }
        // Lines that can be seen.
        assert.ok(contrastRatio(n.borderSubtle, n.surface) >= 1.3, mode);
      }
    }
  });

  it('gives True black, Slate and Warm status colours that read on them', () => {
    // Classic keeps today's (some of its badges and danger text reach only
    // 3:1); the other dark backgrounds have no today to keep.
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
    // The pale text on danger, warning and success badges.
    const badgeText = {
      danger: '#fee2e2',
      warning: '#fef9c3',
      success: '#dcfce7',
    };
    for (const background of THEME_BACKGROUNDS.filter((b) => b !== 'classic')) {
      const vars = themeVariables(look({ background }), 'dark');
      for (const surface of [hex(vars.page), hex(vars.surface)]) {
        for (const status of ['success', 'warning', 'danger', 'info']) {
          assert.ok(
            contrastRatio(hex(vars[`${status}-text`]), surface) >= 4.5,
            `${background} ${status} text on ${surface}`
          );
        }
        for (const [status, text] of Object.entries(badgeText)) {
          // Fills are 80% opaque over the page.
          const fill = over(hex(vars[status]), 0.8, surface);
          assert.ok(
            contrastRatio('#ffffff', fill) >= 4.5,
            `${background} white on ${status}`
          );
          assert.ok(
            contrastRatio(text, fill) >= 4.5,
            `${background} ${status} badge`
          );
        }
      }
    }
    assert.deepEqual(
      ['success', 'warning', 'danger', 'info'].map(
        (status) => themeVariables(classic, 'dark')[status]
      ),
      ['34 197 94', '234 179 8', '220 38 38', '99 102 241']
    );
  });

  it('keeps the count on the page you are on readable in every accent', () => {
    // The request and issue counts beside the page you are on (sidebar and
    // the phone's bar) sit on the accent's deep gradient. Indigo keeps
    // today's indigo-100 text; an accent whose palest shade doesn't read on
    // its gradient gets white.
    assert.equal(
      themeVariables(classic, 'dark')['on-accent-deep'],
      '224 231 255'
    );
    assert.equal(
      themeVariables(look({ accent: 'amber' }), 'dark')['on-accent-deep'],
      '255 255 255'
    );
    const accents = [
      ...THEME_ACCENTS.filter((accent) => accent !== 'custom').map((accent) =>
        look({ accent })
      ),
      ...['#0ea5e9', '#fde68a', '#111827', '#facc15', '#a3e635', '#22d3ee'].map(
        (customAccent) => look({ accent: 'custom', customAccent })
      ),
    ];
    for (const appearance of accents) {
      for (const mode of ['dark', 'light'] as const) {
        const vars = themeVariables(appearance, mode);
        for (const deep of ['accent-700', 'accent-alt-700']) {
          assert.ok(
            contrastRatio(hex(vars['on-accent-deep']), hex(vars[deep])) >= 4.5,
            `${appearance.accent} ${appearance.customAccent ?? ''} ${mode} ${deep}`
          );
        }
      }
    }
  });

  it('makes accent fills solid in dark when the accent’s button text is dark', () => {
    // See-through over a dark page, a bright fill turns too dark for dark
    // text. Other fills (white text on green, teal, red…) keep today's
    // see-through ones, and so do accents with white text.
    const fills = (appearance: Appearance) => {
      const vars = themeVariables(appearance, 'dark');
      return [vars['accent-fill-opacity'], vars['fill-opacity']];
    };
    for (const accent of ['amber', 'plex'] as const) {
      assert.deepEqual(fills(look({ accent })), ['1', '0.8'], accent);
    }
    assert.deepEqual(
      fills(look({ accent: 'custom', customAccent: '#0ea5e9' })),
      ['1', '0.8']
    );
    assert.deepEqual(fills(classic), ['0.8', '0.8']);
    assert.deepEqual(fills(look({ accent: 'teal' })), ['0.8', '0.8']);
  });

  it('has accents whose buttons, links and hovers all read', () => {
    for (const [id, accent] of Object.entries(ACCENTS)) {
      assert.ok(contrastRatio(accent.ink, accent.fill) >= 4.5, id);
      for (const mode of ['dark', 'light'] as const) {
        // Indigo keeps today's link and hover colours in dark.
        if (id === 'indigo' && mode === 'dark') {
          continue;
        }
        assert.ok(
          contrastRatio(accent.ink, accent[mode].hover) >= 4.5,
          `${id} ${mode} hover`
        );
        assert.ok(
          contrastRatio(accent[mode].onChip, accent[mode].chip) >= 4.5,
          `${id} ${mode} chip`
        );
        for (const n of surfacesOf(mode)) {
          for (const surface of [n.page, n.surface]) {
            assert.ok(
              contrastRatio(accent[mode].text, surface) >= 4.5,
              `${id} ${mode} text on ${surface}`
            );
          }
        }
      }
    }
  });

  it('uses the approved colours for each accent', () => {
    // Fill, text on it, and link colour in dark and in light, as designed.
    // Indigo's dark link stays today's indigo-500 so Classic is unchanged.
    const designed: Record<string, [string, string, string, string]> = {
      indigo: ['#4f46e5', '#ffffff', '#6366f1', '#4338ca'],
      seerr: ['#7357f0', '#ffffff', '#b39afc', '#5b3fd9'],
      teal: ['#0f766e', '#ffffff', '#2dd4bf', '#0f766e'],
      green: ['#15803d', '#ffffff', '#4ade80', '#15803d'],
      rose: ['#be123c', '#ffffff', '#fb7185', '#be123c'],
      amber: ['#f59e0b', '#1c1917', '#fbbf24', '#92400e'],
      plex: ['#e5a00d', '#1c1917', '#f5b82e', '#8a5a00'],
      jellyfin: ['#9b4dca', '#ffffff', '#c99ae6', '#7e34ab'],
    };
    for (const [id, accent] of Object.entries(ACCENTS)) {
      assert.deepEqual(
        [accent.fill, accent.ink, accent.dark.text, accent.light.text],
        designed[id],
        id
      );
    }
  });

  it('gives every accent and background its own colours', () => {
    for (const accent of THEME_ACCENTS) {
      for (const background of THEME_BACKGROUNDS) {
        const vars = themeVariables(
          look({ accent, background, customAccent: '#0ea5e9' }),
          'dark'
        );
        assert.equal(
          hex(vars.accent),
          accentColours(look({ accent, customAccent: '#0ea5e9' })).fill
        );
        assert.equal(hex(vars.page), DARK_BACKGROUNDS[background].page);
      }
    }
    assert.equal(
      themeVariables(look({ background: 'black' }), 'dark').page,
      '0 0 0'
    );
    assert.equal(
      themeVariables(look({ mode: 'light' }), 'light').page,
      '243 244 246'
    );
  });
});

describe('a custom accent', () => {
  it('fills buttons with the colour picked, with readable text', () => {
    const vars = themeVariables(
      look({ accent: 'custom', customAccent: '#0ea5e9' }),
      'dark'
    );
    assert.equal(vars.accent, '14 165 233');
    assert.equal(vars['on-accent'], '17 24 39');
  });
});

describe('the extras', () => {
  it('light mode has solid fills and panels, so text on them reads', () => {
    const vars = themeVariables(look({ mode: 'light' }), 'light');
    assert.equal(vars['fill-opacity'], '1');
    assert.equal(vars['panel-opacity'], '1');
    assert.equal(vars['bar-opacity'], '0.9');
  });

  it('solid panels take the see-through out of fills and bars', () => {
    const vars = themeVariables(look({ solidPanels: true }), 'dark');
    assert.equal(vars['fill-opacity'], '1');
    assert.equal(vars['panel-opacity'], '1');
    assert.equal(vars['bar-opacity'], '1');
  });

  it('are marked on <html> only when they differ from the usual', () => {
    assert.deepEqual(
      themeAttributes(
        look({
          mode: 'auto',
          accent: 'rose',
          background: 'warm',
          spacing: 'compact',
          corners: 'square',
          blur: true,
          solidPanels: true,
        })
      ),
      {
        'data-mode': 'dark',
        'data-mode-choice': 'auto',
        'data-theme': 'warm',
        'data-accent': 'rose',
        'data-spacing': 'compact',
        'data-corners': 'square',
        'data-blur': 'on',
        'data-solid': 'on',
      }
    );
  });
});

describe('the stylesheet for a look', () => {
  it('holds only the mode it uses, or both for Match my device', () => {
    assert.match(themeCss(classic), /^:root\[data-mode="dark"\]\{/);
    assert.doesNotMatch(themeCss(classic), /data-mode="light"/);
    assert.doesNotMatch(themeCss(look({ mode: 'light' })), /data-mode="dark"/);
    const both = themeCss(look({ mode: 'auto' }));
    assert.match(both, /data-mode="dark"/);
    assert.match(both, /data-mode="light"/);
    // Nothing but variables, so nothing in it can be anything else.
    assert.match(
      both,
      /^(:root\[data-mode="(dark|light)"\]\{(--[\w-]+:[\d. ]+;)+\})+$/
    );
  });

  it('tells the browser the bar colour for each mode in use', () => {
    assert.deepEqual(themeColour(look({ mode: 'light' })), {
      light: '#ffffff',
    });
    assert.deepEqual(themeColour(look({ mode: 'auto', background: 'black' })), {
      dark: '#141414',
      light: '#ffffff',
    });
  });
});

describe('whose look a page shows', () => {
  const server = {
    mode: 'light' as const,
    accent: 'teal' as const,
    background: 'classic' as const,
  };
  const theirs = look({ accent: 'rose' });
  const device = look({ accent: 'amber' });

  it('is the person’s own once they are signed in', () => {
    assert.deepEqual(
      chosenAppearance({ signedIn: true, own: theirs, device, server }),
      theirs
    );
  });

  it('is the server’s for someone signed in who has not chosen', () => {
    assert.deepEqual(
      chosenAppearance({ signedIn: true, own: null, device, server }),
      appearanceFromDefaults(server)
    );
  });

  it('is the one kept on the device before anyone signs in', () => {
    assert.deepEqual(
      chosenAppearance({ signedIn: false, own: null, device, server }),
      device
    );
    assert.deepEqual(
      chosenAppearance({
        signedIn: false,
        own: null,
        device: undefined,
        server,
      }),
      appearanceFromDefaults(server)
    );
  });
});
