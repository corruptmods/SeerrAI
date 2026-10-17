import type { Appearance } from '@server/constants/theme';
import {
  appearanceFromDefaults,
  cleanAppearance,
  SERVER_THEME_DEFAULTS,
} from '@server/constants/theme';
import type { ThemeFile } from '@server/constants/themeFile';
import { cleanThemeFile } from '@server/constants/themeFile';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { themeColour, themeCss, themeVariables } from './index';
import { DARK_BACKGROUNDS, LIGHT } from './palette';
import {
  appearanceWithThemeFile,
  exportThemeFile,
  galleryLookIn,
  hardToRead,
  THEME_GALLERY,
} from './themeFile';

/*
 * Theme files on the page: what a file's colours change, what exporting
 * one writes, what importing one does to a look, and the built-in gallery.
 */

const classic = appearanceFromDefaults(SERVER_THEME_DEFAULTS);
const look = (changes: Partial<Appearance>): Appearance => ({
  ...classic,
  ...changes,
});
const channels = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');

const ember: ThemeFile = {
  seerrTheme: 1,
  name: 'Ember',
  dark: { page: '#1c1917', textMuted: '#a8a29e', gray: { '900': '#1c1917' } },
  accent: { fill: '#be123c', dark: { text: '#fb7185' } },
  extras: { mode: 'dark', corners: 'square' },
};

describe('a theme file’s colours', () => {
  it('take the place of the look’s where the file gives them', () => {
    const themed = look({ theme: ember });
    const dark = themeVariables(themed, 'dark');
    const plain = themeVariables(classic, 'dark');
    assert.equal(dark.page, channels('#1c1917'));
    assert.equal(dark['gray-900'], channels('#1c1917'));
    assert.equal(dark['text-muted'], channels('#a8a29e'));
    assert.equal(dark['accent-text'], channels('#fb7185'));
    assert.equal(dark.accent, channels('#be123c'));
    // What it leaves out is the look's own.
    assert.equal(dark.surface, plain.surface);
    assert.equal(dark['gray-800'], plain['gray-800']);
    assert.equal(dark['success-text'], plain['success-text']);
    // A file with nothing for light leaves light as it was, but its accent.
    const light = themeVariables(
      look({ mode: 'light', theme: ember }),
      'light'
    );
    assert.equal(light.page, channels(LIGHT.page));
    assert.equal(light.accent, channels('#be123c'));
  });

  it('colour the browser’s bar too', () => {
    const themed = look({
      theme: { ...ember, dark: { surface: '#292524' } },
    });
    assert.deepEqual(themeColour(themed), { dark: '#292524' });
  });

  it('stay out of a look without one', () => {
    assert.equal(themeCss(classic), themeCss(look({})));
    assert.equal(
      themeVariables(classic, 'dark').page,
      channels(DARK_BACKGROUNDS.classic.page)
    );
  });
});

describe('exporting a look', () => {
  const looks: Appearance[] = [
    classic,
    look({ mode: 'light', accent: 'amber' }),
    look({ mode: 'auto', accent: 'teal', background: 'black' }),
    look({ accent: 'custom', customAccent: '#e5a00d', background: 'warm' }),
    look({ theme: ember, accent: 'custom', customAccent: '#be123c' }),
  ];

  it('writes a file the server takes', () => {
    for (const shown of looks) {
      const file = exportThemeFile(shown, 'Mine');
      assert.deepEqual(cleanThemeFile(file), file);
      assert.ok(JSON.stringify(file, null, 2).length < 8 * 1024);
    }
  });

  it('gives the same look back when it is imported, in light and dark', () => {
    for (const shown of looks) {
      const file = exportThemeFile(shown, 'Mine');
      const imported = appearanceWithThemeFile(
        look({ background: 'slate', accent: 'green' }),
        file
      );
      for (const mode of ['dark', 'light'] as const) {
        assert.deepEqual(
          themeVariables(imported, mode),
          themeVariables(shown, mode),
          `${JSON.stringify(shown).slice(0, 60)} ${mode}`
        );
      }
      assert.equal(imported.mode, shown.mode);
      assert.equal(imported.corners, shown.corners);
    }
  });

  it('keeps the name and author of the theme file in use', () => {
    const file = exportThemeFile(
      look({ theme: { ...ember, author: 'Sam' } }),
      'Ignored'
    );
    assert.equal(file.name, 'Ember');
    assert.equal(file.author, 'Sam');
  });
});

describe('importing a theme file', () => {
  it('uses its accent and settings, and keeps the person’s own otherwise', () => {
    const mine = look({
      mode: 'light',
      background: 'slate',
      spacing: 'compact',
      seasonal: false,
    });
    const imported = appearanceWithThemeFile(mine, ember);
    assert.deepEqual(imported, {
      ...mine,
      mode: 'dark',
      corners: 'square',
      accent: 'custom',
      customAccent: '#be123c',
      theme: ember,
    });
    assert.ok(cleanAppearance(imported));
  });

  it('works for the server’s default, which has no extras', () => {
    const imported = appearanceWithThemeFile(SERVER_THEME_DEFAULTS, ember);
    assert.deepEqual(imported, {
      mode: 'dark',
      accent: 'custom',
      customAccent: '#be123c',
      background: 'classic',
      theme: ember,
    });
  });

  it('warns when its text would be hard to read', () => {
    assert.deepEqual(hardToRead(look({ theme: ember })), []);
    const murky = look({
      mode: 'auto',
      theme: {
        seerrTheme: 1,
        name: 'Murky',
        dark: { textMuted: '#374151' },
        accent: { ink: '#4f46e5' },
      },
    });
    assert.deepEqual(hardToRead(murky), [
      'dark:textMuted',
      'dark:ink',
      'light:ink',
    ]);
  });
});

describe('the gallery', () => {
  it('has Seerr Classic, Midnight, Daylight and Ember', () => {
    assert.deepEqual(
      THEME_GALLERY.map((entry) => [entry.id, entry.look]),
      [
        ['classic', { mode: 'dark', accent: 'indigo', background: 'classic' }],
        ['midnight', { mode: 'dark', accent: 'teal', background: 'black' }],
        ['daylight', { mode: 'light', accent: 'indigo' }],
        ['ember', { mode: 'dark', accent: 'rose', background: 'warm' }],
      ]
    );
  });

  it('knows which one a look is, unless a theme file is in use', () => {
    assert.equal(galleryLookIn(classic)?.id, 'classic');
    assert.equal(
      galleryLookIn(look({ mode: 'light', background: 'slate' }))?.id,
      'daylight'
    );
    assert.equal(galleryLookIn(look({ accent: 'teal' })), undefined);
    assert.equal(galleryLookIn(look({ theme: ember })), undefined);
  });
});
