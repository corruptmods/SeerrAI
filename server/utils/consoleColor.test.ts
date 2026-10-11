import { consoleColor } from '@server/utils/consoleColor';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('console log colour', () => {
  it('is on at a terminal and off when piped or in a container log', () => {
    assert.equal(consoleColor({}, true), true);
    assert.equal(consoleColor({}, false), false);
    assert.equal(consoleColor({}, undefined), false);
  });

  it('honours NO_COLOR and TERM=dumb even at a terminal', () => {
    assert.equal(consoleColor({ NO_COLOR: '1' }, true), false);
    assert.equal(consoleColor({ TERM: 'dumb' }, true), false);
    // An empty NO_COLOR does not count (no-color.org).
    assert.equal(consoleColor({ NO_COLOR: '' }, true), true);
  });

  it('lets FORCE_COLOR decide either way', () => {
    assert.equal(consoleColor({ FORCE_COLOR: '1' }, false), true);
    assert.equal(consoleColor({ FORCE_COLOR: '0' }, true), false);
    assert.equal(consoleColor({ FORCE_COLOR: 'false' }, true), false);
    assert.equal(
      consoleColor({ FORCE_COLOR: '1', NO_COLOR: '1' }, true),
      false
    );
  });
});
