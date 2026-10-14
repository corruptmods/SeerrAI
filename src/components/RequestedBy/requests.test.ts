import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newestFirst, seasonGroups } from './requests';

/* How a title page lists the requests made for it. */

describe('the requests on a title page', () => {
  it('lists the newest request first', () => {
    const requests = [
      { id: 1, createdAt: new Date('2026-01-05T10:00:00Z') },
      { id: 2, createdAt: new Date('2026-03-01T10:00:00Z') },
      // As the page receives it: a date written out.
      { id: 3, createdAt: '2026-02-01T10:00:00Z' as unknown as Date },
    ];
    assert.deepEqual(
      newestFirst(requests).map((r) => r.id),
      [2, 3, 1]
    );
    // The page's own copy is left as it was.
    assert.deepEqual(
      requests.map((r) => r.id),
      [1, 2, 3]
    );
  });

  it('names a run of seasons by its first and last', () => {
    assert.deepEqual(seasonGroups([3, 1, 2, 5, 7, 8]), {
      specials: false,
      count: 6,
      list: '1–3, 5, 7–8',
    });
  });

  it('names a single season on its own', () => {
    assert.deepEqual(seasonGroups([4]), {
      specials: false,
      count: 1,
      list: '4',
    });
  });

  it('counts specials apart from the numbered seasons', () => {
    assert.deepEqual(seasonGroups([0, 1, 2]), {
      specials: true,
      count: 2,
      list: '1–2',
    });
    assert.deepEqual(seasonGroups([0]), {
      specials: true,
      count: 0,
      list: '',
    });
  });

  it('counts a season asked for twice once', () => {
    assert.deepEqual(seasonGroups([2, 2, 3]), {
      specials: false,
      count: 2,
      list: '2–3',
    });
  });
});
