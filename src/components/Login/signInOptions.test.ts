import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { labelWidth, optionColumns, spansRow } from './signInOptions';

describe('the other ways to sign in', () => {
  it('sizes columns by the widest label, at least half the width', () => {
    assert.equal(
      optionColumns(['Plex', 'Emby', 'authentik', 'Seerr AI']),
      'repeat(auto-fit, minmax(min(100%, max(calc(9ch + 4rem), calc(50% - 0.3rem))), 1fr))'
    );
  });

  it('counts wide characters twice', () => {
    assert.equal(labelWidth('Passkey'), 7);
    assert.equal(labelWidth('パスキー'), 8);
    assert.equal(labelWidth('패스키'), 6);
  });

  it('lets the last of an odd number take the whole row', () => {
    assert.equal(spansRow(0, 1), true);
    assert.equal(spansRow(2, 3), true);
    assert.equal(spansRow(1, 3), false);
    assert.equal(spansRow(3, 4), false);
  });
});
