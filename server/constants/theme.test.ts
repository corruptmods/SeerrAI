import {
  appearanceCookieValue,
  appearanceFromCookie,
  appearanceFromDefaults,
  cleanAppearance,
  cleanHexColour,
  cleanThemeDefaults,
  SERVER_THEME_DEFAULTS,
} from '@server/constants/theme';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * How a person's look (Profile → Settings → Appearance) and the server's
 * default (Settings → Appearance) are checked before they are kept.
 */

const mine = {
  mode: 'light',
  accent: 'teal',
  background: 'slate',
  spacing: 'compact',
  corners: 'square',
  blur: false,
  solidPanels: true,
  seasonal: false,
};

describe('a colour typed or picked', () => {
  it('is kept as six lower-case hex digits', () => {
    assert.equal(cleanHexColour('#0EA5E9'), '#0ea5e9');
    assert.equal(cleanHexColour('#abc'), '#aabbcc');
    assert.equal(cleanHexColour(' #123456 '), '#123456');
  });

  it('is refused when it is anything else', () => {
    for (const value of [
      '0ea5e9',
      '#0ea5e',
      '#0ea5e9ff',
      'red',
      'rgb(1,2,3)',
      '#ggg',
      'url(x)',
      12,
      null,
      undefined,
    ]) {
      assert.equal(cleanHexColour(value), undefined, String(value));
    }
  });
});

describe('a person’s look', () => {
  it('is kept as sent when every part is known', () => {
    assert.deepEqual(cleanAppearance(mine), mine);
  });

  it('fills in the extras someone did not send', () => {
    assert.deepEqual(
      cleanAppearance({ mode: 'dark', accent: 'rose', background: 'warm' }),
      {
        mode: 'dark',
        accent: 'rose',
        background: 'warm',
        spacing: 'comfortable',
        corners: 'rounded',
        blur: false,
        solidPanels: false,
        seasonal: true,
      }
    );
  });

  it('keeps a custom colour only for the custom accent', () => {
    assert.equal(
      cleanAppearance({ ...mine, accent: 'custom', customAccent: '#0EA5E9' })
        ?.customAccent,
      '#0ea5e9'
    );
    // A preset leaves no stray colour behind.
    assert.equal(
      'customAccent' in
        (cleanAppearance({ ...mine, customAccent: '#0ea5e9' }) ?? {}),
      false
    );
  });

  it('is refused when anything is unknown or missing', () => {
    for (const bad of [
      null,
      'dark',
      [],
      { ...mine, mode: 'dim' },
      { ...mine, accent: 'purple' },
      { ...mine, background: 'white' },
      { ...mine, spacing: 'tight' },
      { ...mine, corners: 'round' },
      { ...mine, blur: 'yes' },
      { ...mine, solidPanels: 1 },
      { ...mine, seasonal: null },
      { ...mine, accent: 'custom' },
      { ...mine, accent: 'custom', customAccent: 'blue' },
      { ...mine, colour: '#000000' },
      { accent: 'teal', background: 'slate' },
    ]) {
      assert.equal(cleanAppearance(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe('the server’s default look', () => {
  it('is dark Classic with Indigo until an admin changes it', () => {
    assert.deepEqual(SERVER_THEME_DEFAULTS, {
      mode: 'dark',
      accent: 'indigo',
      background: 'classic',
    });
  });

  it('is checked like a person’s, without the extras', () => {
    assert.deepEqual(
      cleanThemeDefaults({
        mode: 'auto',
        accent: 'custom',
        customAccent: '#E5A00D',
        background: 'black',
      }),
      {
        mode: 'auto',
        accent: 'custom',
        customAccent: '#e5a00d',
        background: 'black',
      }
    );
    for (const bad of [
      { mode: 'auto', accent: 'teal' },
      { mode: 'auto', accent: 'teal', background: 'classic', blur: true },
      { mode: 'auto', accent: 'custom', background: 'classic' },
    ]) {
      assert.equal(cleanThemeDefaults(bad), undefined, JSON.stringify(bad));
    }
  });

  it('gives someone who has not chosen the usual extras', () => {
    assert.deepEqual(
      appearanceFromDefaults({
        mode: 'light',
        accent: 'custom',
        customAccent: '#123456',
        background: 'warm',
      }),
      {
        mode: 'light',
        accent: 'custom',
        customAccent: '#123456',
        background: 'warm',
        spacing: 'comfortable',
        corners: 'rounded',
        blur: false,
        solidPanels: false,
        seasonal: true,
      }
    );
  });
});

describe('blur behind title pages', () => {
  // Title pages looked sharp before there were looks to choose; upgrading
  // must not soften them for anyone who never asked for it.
  it('is off for someone who has not chosen it', () => {
    assert.equal(appearanceFromDefaults(SERVER_THEME_DEFAULTS).blur, false);
    assert.equal(
      cleanAppearance({ mode: 'dark', accent: 'indigo', background: 'classic' })
        ?.blur,
      false
    );
  });

  it('stays on for someone who turned it on', () => {
    assert.equal(
      cleanAppearance({
        mode: 'dark',
        accent: 'indigo',
        background: 'classic',
        blur: true,
      })?.blur,
      true
    );
  });
});

describe('the copy of a look kept on the device', () => {
  it('reads back what was written', () => {
    const custom = { ...mine, accent: 'custom', customAccent: '#0ea5e9' };
    const cookie = appearanceCookieValue(cleanAppearance(custom)!);
    assert.match(cookie, /^[A-Za-z0-9%._~-]+$/);
    assert.deepEqual(
      appearanceFromCookie(`a=1; seerr-theme=${cookie}`),
      custom
    );
  });

  it('is ignored when it is missing, garbled or not a look', () => {
    for (const header of [
      undefined,
      '',
      'other=1',
      'seerr-theme=%7B',
      `seerr-theme=${encodeURIComponent('{"mode":"dim"}')}`,
      `seerr-theme=${encodeURIComponent('"dark"')}`,
    ]) {
      assert.equal(appearanceFromCookie(header), undefined, String(header));
    }
  });
});
