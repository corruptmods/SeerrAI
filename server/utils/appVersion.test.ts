import { devBuildStatus } from '@server/utils/appVersion';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * A build from build.sh carries the short commit hash; GitHub lists full
 * ones. Compared whole, the two never matched, so such a build always read
 * as out of date.
 */

const shas = [
  'f7f224cba74095ac36fb9e2ca4e7f40940d0c5d0',
  'ae509dc3d06923341ba1fa962710bf000fabe4b8',
  '7f150a224c2de208735a080bbd0b7563843460de',
];

describe('development build update check', () => {
  it('is up to date at the newest commit, by short or full hash', () => {
    for (const tag of ['f7f224c', shas[0]]) {
      assert.deepEqual(devBuildStatus(shas, tag), {
        updateAvailable: false,
        commitsBehind: 0,
      });
    }
  });

  it('counts the commits since this build', () => {
    assert.deepEqual(devBuildStatus(shas, '7f150a2'), {
      updateAvailable: true,
      commitsBehind: 2,
    });
  });

  it('says out of date, by an unknown count, for a commit not listed', () => {
    assert.deepEqual(devBuildStatus(shas, '0123456'), {
      updateAvailable: true,
      commitsBehind: -1,
    });
  });

  it('matches nothing on a hash too short to tell', () => {
    assert.equal(devBuildStatus(shas, 'f7f').updateAvailable, true);
  });

  it('assumes nothing when GitHub lists no commits', () => {
    assert.deepEqual(devBuildStatus([], 'f7f224c'), {
      updateAvailable: false,
      commitsBehind: 0,
    });
  });
});
