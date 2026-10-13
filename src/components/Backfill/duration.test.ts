import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { durationParts } from './duration';

describe('durationParts', () => {
  it('rounds to the minute before splitting off the hours', () => {
    assert.deepEqual(durationParts(2 * 3600 - 20), { hours: 2, minutes: 0 });
    assert.deepEqual(durationParts(3600 + 59 * 60 + 29), {
      hours: 1,
      minutes: 59,
    });
  });

  it('reads at least a minute', () => {
    assert.deepEqual(durationParts(5), { hours: 0, minutes: 1 });
    assert.deepEqual(durationParts(150), { hours: 0, minutes: 3 });
  });
});
