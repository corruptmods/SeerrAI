import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyMusicPage } from './emptyPage';

const answered = (count: number) => ({ loaded: true, count });
const waiting = { loaded: false, count: 0 };

describe('the Music page with nothing in its rows', () => {
  it('says nothing while a row is still loading', () => {
    assert.equal(
      emptyMusicPage([answered(0), waiting, answered(0)], true, false),
      null
    );
  });

  it('says nothing once any row has something', () => {
    assert.equal(
      emptyMusicPage([answered(0), answered(3), answered(0)], true, false),
      null
    );
  });

  it('counts a row that failed as empty', () => {
    // A row whose source did not answer hides itself, as an empty one does.
    assert.deepEqual(emptyMusicPage([answered(0), answered(0)], false, true), {
      hints: [],
    });
  });

  it('only asks everyone else to search', () => {
    assert.deepEqual(emptyMusicPage([answered(0)], false, undefined), {
      hints: [],
    });
  });

  it('tells an admin what would fill it', () => {
    // New and Popular Music switched off: those rows stay empty until it is
    // switched on, and Recently Added fills as albums reach the server.
    assert.deepEqual(emptyMusicPage([answered(0)], true, false), {
      hints: ['listenBrainz', 'albumsHere'],
    });
    // Switched on (ListenBrainz had nothing, or did not answer), or not
    // known yet: only the albums.
    assert.deepEqual(emptyMusicPage([answered(0)], true, true), {
      hints: ['albumsHere'],
    });
    assert.deepEqual(emptyMusicPage([answered(0)], true, undefined), {
      hints: ['albumsHere'],
    });
  });
});
