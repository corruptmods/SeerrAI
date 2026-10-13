import {
  parseSeasonKey,
  seasonDates,
  seasonKey,
  seasonOf,
  shiftSeason,
} from '@server/utils/animeSeason';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* Anime seasons are the calendar's quarters, named as anime fans do. */

describe('anime seasons', () => {
  it('names the quarter a day falls in', () => {
    assert.deepEqual(seasonOf(new Date(2026, 0, 1)), {
      year: 2026,
      name: 'winter',
    });
    assert.deepEqual(seasonOf(new Date(2026, 2, 31, 23, 59)), {
      year: 2026,
      name: 'winter',
    });
    assert.deepEqual(seasonOf(new Date(2026, 3, 1)), {
      year: 2026,
      name: 'spring',
    });
    assert.deepEqual(seasonOf(new Date(2026, 6, 15)), {
      year: 2026,
      name: 'summer',
    });
    assert.deepEqual(seasonOf(new Date(2026, 9, 13)), {
      year: 2026,
      name: 'fall',
    });
    assert.deepEqual(seasonOf(new Date(2026, 11, 31)), {
      year: 2026,
      name: 'fall',
    });
  });

  it('steps back and forward across the turn of the year', () => {
    const fall = { year: 2026, name: 'fall' } as const;
    assert.deepEqual(shiftSeason(fall, 1), { year: 2027, name: 'winter' });
    assert.deepEqual(shiftSeason(fall, -1), { year: 2026, name: 'summer' });
    const winter = { year: 2027, name: 'winter' } as const;
    assert.deepEqual(shiftSeason(winter, -1), { year: 2026, name: 'fall' });
    assert.deepEqual(shiftSeason(winter, 0), winter);
  });

  it('runs from the first day of its quarter to the last', () => {
    assert.deepEqual(seasonDates({ year: 2026, name: 'winter' }), {
      start: '2026-01-01',
      end: '2026-03-31',
    });
    assert.deepEqual(seasonDates({ year: 2026, name: 'spring' }), {
      start: '2026-04-01',
      end: '2026-06-30',
    });
    assert.deepEqual(seasonDates({ year: 2026, name: 'summer' }), {
      start: '2026-07-01',
      end: '2026-09-30',
    });
    assert.deepEqual(seasonDates({ year: 2026, name: 'fall' }), {
      start: '2026-10-01',
      end: '2026-12-31',
    });
  });

  it('is written in an address as year and name, and read back', () => {
    const season = { year: 2027, name: 'winter' } as const;
    assert.equal(seasonKey(season), '2027-winter');
    assert.deepEqual(parseSeasonKey('2027-winter'), season);
  });

  it('reads nothing from an address it does not recognise', () => {
    for (const key of [
      undefined,
      '',
      'winter',
      '2027-autumn',
      '2027-Winter',
      '27-winter',
      '2027-winter-x',
      '0999-fall',
    ]) {
      assert.equal(parseSeasonKey(key), null, String(key));
    }
  });
});
