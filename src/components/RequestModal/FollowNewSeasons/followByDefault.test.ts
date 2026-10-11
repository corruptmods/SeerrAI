import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import followByDefault from './followByDefault';

const base = {
  partialRequestsEnabled: true,
  selected: [] as number[],
  requestable: [1, 2, 3],
  partSeasons: [] as number[],
  latestAired: 3,
};

describe('"Also get new seasons" starts ticked', () => {
  it('when every season is being requested', () => {
    assert.equal(followByDefault({ ...base, selected: [1, 2, 3] }), true);
  });

  it('when every season left is being requested, some already here', () => {
    assert.equal(
      followByDefault({ ...base, selected: [2, 3], requestable: [2, 3] }),
      true
    );
  });

  it('whether or not specials are ticked too', () => {
    assert.equal(
      followByDefault({
        ...base,
        selected: [0, 1, 2, 3],
        requestable: [0, 1, 2, 3],
      }),
      true
    );
    assert.equal(
      followByDefault({
        ...base,
        selected: [1, 2, 3],
        requestable: [0, 1, 2, 3],
      }),
      true
    );
  });

  it('when only the newest season is ticked', () => {
    assert.equal(followByDefault({ ...base, selected: [3] }), true);
  });

  it('when a series request always takes every season', () => {
    assert.equal(
      followByDefault({ ...base, partialRequestsEnabled: false }),
      true
    );
  });

  it('not for some of the seasons', () => {
    assert.equal(followByDefault({ ...base, selected: [1, 2] }), false);
    assert.equal(followByDefault({ ...base, selected: [1] }), false);
  });

  it('not when a season is ticked for only some episodes', () => {
    assert.equal(
      followByDefault({ ...base, selected: [1, 2, 3], partSeasons: [2] }),
      false
    );
  });

  it('not when nothing is ticked yet', () => {
    assert.equal(followByDefault(base), false);
    assert.equal(followByDefault({ ...base, selected: [0] }), false);
  });
});
