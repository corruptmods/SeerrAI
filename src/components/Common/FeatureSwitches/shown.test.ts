import { FEATURES } from '@server/constants/features';
import { Permission } from '@server/lib/permissions';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NOT_ON_FEATURES_PAGE,
  NOT_ON_MUSIC_PAGE,
  shownFeatures,
  unusableFeatures,
} from './shown';

describe('the feature switches each page shows', () => {
  it('leave music off Settings → Features, which has every other one', () => {
    // Music is switched on Settings → Music; Features links there.
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
    assert.equal(shownFeatures([], true).includes('music'), true);
    assert.equal(shownFeatures([], false).includes('music'), false);
  });

  it('leave out list requests for someone who cannot request', () => {
    assert.equal(
      unusableFeatures(Permission.NONE).includes('listRequests'),
      true
    );
    for (const permission of [
      Permission.REQUEST,
      Permission.REQUEST_MOVIE,
      Permission.REQUEST_TV,
      Permission.ADMIN,
    ]) {
      assert.equal(
        unusableFeatures(permission).includes('listRequests'),
        false
      );
    }
  });

  it('leave out admin tools for everyone but admins', () => {
    assert.deepEqual(unusableFeatures(Permission.ADMIN), []);
    const requester = unusableFeatures(Permission.REQUEST);
    for (const tool of ['aiLogs', 'aiBackfill', 'aiAgent', 'siri'] as const) {
      assert.equal(requester.includes(tool), true);
    }
    assert.equal(
      unusableFeatures(Permission.CREATE_ISSUES).includes('siri'),
      false
    );
  });
});
