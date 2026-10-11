import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countActiveFilters, prepareFilterValues } from './filters';

describe('prepareFilterValues', () => {
  it('keeps the filters in the address and drops the rest', () => {
    assert.deepEqual(
      prepareFilterValues({
        genre: '18',
        voteAverageGte: '7',
        page: '2',
        certification: '',
      }),
      { genre: '18', voteAverageGte: '7' }
    );
  });

  it('uses the first of a filter given twice, rather than failing', () => {
    assert.deepEqual(prepareFilterValues({ genre: ['18', '35'] }), {
      genre: '18',
    });
  });

  it('works out how certifications are matched', () => {
    assert.equal(
      prepareFilterValues({ certification: 'PG' }).certificationMode,
      'exact'
    );
    assert.equal(
      prepareFilterValues({ certificationGte: 'PG' }).certificationMode,
      'range'
    );
    assert.equal(
      prepareFilterValues({ certificationMode: 'sideways' }).certificationMode,
      undefined
    );
  });

  it('counts a range as one filter', () => {
    assert.equal(
      countActiveFilters(
        prepareFilterValues({
          voteAverageGte: '6',
          voteAverageLte: '9',
          genre: '18',
        })
      ),
      2
    );
  });
});
