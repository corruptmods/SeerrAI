import {
  appearanceCookieValue,
  appearanceFromCookie,
  cleanAppearance,
  cleanThemeDefaults,
} from '@server/constants/theme';
import {
  THEME_FILE_MAX_BYTES,
  checkThemeFile,
  cleanThemeFile,
  readThemeFile,
  withoutThemeFile,
} from '@server/constants/themeFile';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Theme files: a look someone can share, holding colours and a few
 * settings only. They are checked strictly wherever they come from (a file
 * being imported, a saved look, settings.json), so nothing but colours and
 * known values can reach the page.
 */

const ember = {
  seerrTheme: 1,
  name: 'Ember',
  author: 'Sam',
  dark: {
    page: '#1C1917',
    surface: '#292524',
    textMuted: '#a8a29e',
    gray: { '800': '#292524', '900': '#1c1917' },
  },
  light: { page: '#fafaf9' },
  accent: {
    fill: '#be123c',
    ink: '#fff',
    scale: { '500': '#f43f5e' },
    dark: { text: '#fb7185' },
  },
  extras: { mode: 'dark', corners: 'square', blur: false },
};

describe('a theme file', () => {
  it('is kept with every colour tidied', () => {
    const theme = cleanThemeFile(ember);
    assert.deepEqual(theme, {
      ...ember,
      dark: { ...ember.dark, page: '#1c1917' },
      accent: { ...ember.accent, ink: '#ffffff' },
    });
  });

  it('needs only its marker and a name', () => {
    assert.deepEqual(cleanThemeFile({ seerrTheme: 1, name: ' Plain ' }), {
      seerrTheme: 1,
      name: 'Plain',
    });
  });

  it('is read from the text of a file', () => {
    const read = readThemeFile(JSON.stringify(ember));
    assert.ok('theme' in read);
    assert.equal(read.theme.name, 'Ember');
  });

  it('says what is wrong with one that cannot be used', () => {
    const problem = (value: unknown) => {
      const result = checkThemeFile(value);
      return 'theme' in result ? undefined : result;
    };
    assert.deepEqual(problem('dark'), { problem: 'notThemeFile' });
    assert.deepEqual(problem([]), { problem: 'notThemeFile' });
    assert.deepEqual(problem({ name: 'No marker' }), {
      problem: 'notThemeFile',
    });
    assert.deepEqual(problem({ seerrTheme: 2, name: 'Future' }), {
      problem: 'newerVersion',
    });
    assert.deepEqual(problem({ seerrTheme: 1 }), { problem: 'name' });
    assert.deepEqual(problem({ seerrTheme: 1, name: '   ' }), {
      problem: 'name',
    });
    assert.deepEqual(problem({ seerrTheme: 1, name: 'x'.repeat(61) }), {
      problem: 'name',
    });
    assert.deepEqual(problem({ seerrTheme: 1, name: 'Bell\u0007' }), {
      problem: 'name',
    });
    assert.deepEqual(problem({ ...ember, css: 'body{}' }), {
      problem: 'unknownKey',
      key: 'css',
    });
    assert.deepEqual(
      problem({ ...ember, dark: { ...ember.dark, backgroundImage: '#000' } }),
      { problem: 'unknownKey', key: 'dark.backgroundImage' }
    );
    assert.deepEqual(
      problem({ ...ember, dark: { page: 'url(https://evil.example/x)' } }),
      { problem: 'notColour', key: 'dark.page' }
    );
    assert.deepEqual(
      problem({ ...ember, dark: { gray: { '1000': '#000000' } } }),
      { problem: 'unknownKey', key: 'dark.gray.1000' }
    );
    assert.deepEqual(problem({ ...ember, dark: { gray: '#000000' } }), {
      problem: 'notValue',
      key: 'dark.gray',
    });
    assert.deepEqual(
      problem({ ...ember, accent: { fill: 'red; } body { x' } }),
      { problem: 'notColour', key: 'accent.fill' }
    );
    assert.deepEqual(
      problem({ ...ember, accent: { light: { glow: '#fff' } } }),
      {
        problem: 'unknownKey',
        key: 'accent.light.glow',
      }
    );
    assert.deepEqual(problem({ ...ember, extras: { mode: 'dim' } }), {
      problem: 'notValue',
      key: 'extras.mode',
    });
    assert.deepEqual(problem({ ...ember, extras: { blur: 'yes' } }), {
      problem: 'notValue',
      key: 'extras.blur',
    });
    assert.deepEqual(problem({ ...ember, extras: { seasonal: false } }), {
      problem: 'unknownKey',
      key: 'extras.seasonal',
    });
    assert.deepEqual(problem({ ...ember, author: 12 }), {
      problem: 'notValue',
      key: 'author',
    });
  });

  it('refuses text that is not JSON, or too large', () => {
    assert.deepEqual(readThemeFile('{ nope'), { problem: 'notJson' });
    assert.deepEqual(
      readThemeFile(
        JSON.stringify({ ...ember, name: 'Big' }) +
          ' '.repeat(THEME_FILE_MAX_BYTES)
      ),
      { problem: 'tooLarge' }
    );
    // Counted in bytes, so wide characters can't slip past the limit.
    assert.deepEqual(
      checkThemeFile({
        ...ember,
        author: '😀'.repeat(THEME_FILE_MAX_BYTES / 4),
      }),
      { problem: 'tooLarge' }
    );
  });

  it('is never taken from an inherited key', () => {
    const sneaky = Object.create({ seerrTheme: 1, name: 'Inherited' });
    assert.equal(cleanThemeFile(sneaky), undefined);
    assert.deepEqual(
      checkThemeFile(JSON.parse('{"seerrTheme":1,"name":"P","__proto__":{}}')),
      { problem: 'unknownKey', key: '__proto__' }
    );
  });
});

describe('a look using a theme file', () => {
  const look = {
    mode: 'dark',
    accent: 'custom',
    customAccent: '#be123c',
    background: 'warm',
  };

  it('is kept by a person and by the server, with the file checked', () => {
    const theme = cleanThemeFile(ember);
    assert.deepEqual(cleanThemeDefaults({ ...look, theme: ember }), {
      ...look,
      theme,
    });
    assert.deepEqual(cleanAppearance({ ...look, theme: ember })?.theme, theme);
  });

  it('is refused whole when its file is not a theme file', () => {
    for (const theme of [
      null,
      'Ember',
      { ...ember, dark: { page: 'red' } },
      { ...ember, script: true },
    ]) {
      assert.equal(cleanThemeDefaults({ ...look, theme }), undefined);
      assert.equal(cleanAppearance({ ...look, theme }), undefined);
    }
  });

  it('keeps its file out of the copy on the device, which stays small', () => {
    const appearance = cleanAppearance({ ...look, theme: ember });
    assert.ok(appearance);
    const cookie = appearanceCookieValue(appearance);
    assert.doesNotMatch(decodeURIComponent(cookie), /Ember/);
    const copy = appearanceFromCookie(`seerr-theme=${cookie}`);
    assert.deepEqual(copy, withoutThemeFile(appearance));
    assert.equal(copy?.customAccent, '#be123c');
  });
});
