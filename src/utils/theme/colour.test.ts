import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DARK_INK,
  SCALE_STEPS,
  accentFromColour,
  accentScale,
  contrastRatio,
  fromOklch,
  hexToRgb,
  pickInk,
  rgbToHex,
  toOklch,
} from './colour';

/*
 * The colour arithmetic behind a custom accent: a whole scale made from one
 * colour, and text on it that stays readable.
 */

// The surfaces text sits on in every dark background, and in light mode.
const DARK_SURFACES = [
  '#111827',
  '#1f2937',
  '#000000',
  '#141414',
  '#0f172a',
  '#1e293b',
  '#1c1917',
  '#292524',
];
const LIGHT_SURFACES = ['#ffffff', '#f3f4f6'];

const lightness = (hex: string) => toOklch(hexToRgb(hex)).l;

describe('colours and contrast', () => {
  it('reads and writes hex', () => {
    assert.deepEqual(hexToRgb('#4f46e5'), [79, 70, 229]);
    assert.equal(rgbToHex([79, 70, 229]), '#4f46e5');
    assert.equal(rgbToHex([0, 255, 16]), '#00ff10');
  });

  it('measures contrast as WCAG does', () => {
    assert.equal(contrastRatio('#ffffff', '#000000'), 21);
    assert.equal(contrastRatio('#777777', '#777777'), 1);
    assert.equal(+contrastRatio('#4f46e5', '#ffffff').toFixed(2), 6.29);
    assert.equal(
      contrastRatio('#ffffff', '#4f46e5'),
      contrastRatio('#4f46e5', '#ffffff')
    );
  });

  it('goes to OKLCH and back without changing the colour', () => {
    for (const hex of [
      '#4f46e5',
      '#0ea5e9',
      '#e5a00d',
      '#9b4dca',
      '#000000',
      '#ffffff',
      '#808080',
      '#ff0000',
    ]) {
      assert.equal(rgbToHex(fromOklch(toOklch(hexToRgb(hex)))), hex, hex);
    }
  });
});

describe('text on a colour', () => {
  it('is white when white is readable, and dark otherwise', () => {
    assert.equal(pickInk('#4f46e5'), '#ffffff');
    assert.equal(pickInk('#0f766e'), '#ffffff');
    assert.equal(pickInk('#f59e0b'), DARK_INK);
    assert.equal(pickInk('#0ea5e9'), DARK_INK);
    assert.equal(pickInk('#ffff00'), DARK_INK);
  });

  it('is always at least 4.5:1, whatever the colour', () => {
    for (let i = 0; i < 4096; i++) {
      const hex = rgbToHex([(i * 37) % 256, (i * 101) % 256, (i * 13) % 256]);
      assert.ok(contrastRatio(pickInk(hex), hex) >= 4.5, hex);
    }
  });
});

describe('a scale made from one colour', () => {
  it('has every step, light to dark, with the colour itself in it', () => {
    for (const hex of [
      '#0ea5e9',
      '#7357f0',
      '#e5a00d',
      '#9b4dca',
      '#be123c',
      '#808080',
      '#fefefe',
      '#020202',
    ]) {
      const { scale, anchor } = accentScale(hex);
      assert.deepEqual(Object.keys(scale).map(Number), [...SCALE_STEPS]);
      assert.equal(scale[anchor], hex);
      for (let i = 1; i < SCALE_STEPS.length; i++) {
        assert.ok(
          lightness(scale[SCALE_STEPS[i - 1]]) >=
            lightness(scale[SCALE_STEPS[i]]),
          `${hex} ${SCALE_STEPS[i]}`
        );
        assert.match(scale[SCALE_STEPS[i]], /^#[0-9a-f]{6}$/);
      }
    }
  });

  it('puts the colour where its lightness belongs', () => {
    assert.equal(accentScale('#0ea5e9').anchor, 400);
    assert.equal(accentScale('#4f46e5').anchor, 600);
    assert.equal(accentScale('#e5a00d').anchor, 300);
  });
});

describe('an accent made from one colour', () => {
  it('fills buttons with the colour, and keeps every text readable', () => {
    for (let i = 0; i < 400; i++) {
      const hex = rgbToHex([(i * 53) % 256, (i * 151) % 256, (i * 29) % 256]);
      const accent = accentFromColour(hex);
      assert.equal(accent.fill, hex);
      assert.ok(contrastRatio(accent.ink, accent.fill) >= 4.5, `${hex} ink`);
      for (const mode of ['dark', 'light'] as const) {
        assert.ok(
          contrastRatio(accent.ink, accent[mode].hover) >= 4.5,
          `${hex} ${mode} hover`
        );
        for (const surface of mode === 'dark'
          ? DARK_SURFACES
          : LIGHT_SURFACES) {
          assert.ok(
            contrastRatio(accent[mode].text, surface) >= 4.5,
            `${hex} ${mode} text on ${surface}`
          );
        }
      }
    }
  });

  it('says when the button text had to turn dark', () => {
    assert.equal(accentFromColour('#0ea5e9').inkIsDark, true);
    assert.equal(accentFromColour('#1e3a8a').inkIsDark, false);
  });

  it('has a partner colour for gradients, a little further round', () => {
    const { scale, alt } = accentFromColour('#0ea5e9');
    const hueOf = (hex: string) => toOklch(hexToRgb(hex)).h;
    const turn = (hueOf(alt[500]) - hueOf(scale[500]) + 360) % 360;
    assert.ok(turn > 20 && turn < 40, String(turn));
  });
});
