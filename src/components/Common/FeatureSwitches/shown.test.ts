import { FEATURES } from '@server/constants/features';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NOT_ON_FEATURES_PAGE,
  NOT_ON_MUSIC_PAGE,
  shownFeatures,
} from './shown';

describe('the feature switches each page shows', () => {
  it('leave music off Settings → Features, which has every other one', () => {
    // Music is switched on Settings → Music; Features only points there.
    for (const musicReady of [true, false]) {
      const shown = shownFeatures(NOT_ON_FEATURES_PAGE, musicReady);
      assert.equal(shown.includes('music'), false);
      assert.deepEqual(
        shown,
        FEATURES.filter((feature) => feature !== 'music')
      );
    }
  });

  it('are the Music switch alone on Settings → Music', () => {
    assert.deepEqual(shownFeatures(NOT_ON_MUSIC_PAGE, true), ['music']);
  });

  it('still offer music to each person, once it is there', () => {
    // Profile → Settings → Features is unchanged.
    assert.equal(shownFeatures([], true).includes('music'), true);
    assert.equal(shownFeatures([], false).includes('music'), false);
  });
});
