import { ratingFromResponse } from '@server/api/rating/imdbGraphql';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('IMDb ratings', () => {
  it('reads a series rating and its votes', () => {
    assert.deepEqual(
      ratingFromResponse('tt8399141', {
        data: {
          title: {
            id: 'tt8399141',
            titleText: { text: 'Halvorsen' },
            ratingsSummary: { aggregateRating: 8, voteCount: 318451 },
          },
        },
      }),
      {
        title: 'Halvorsen',
        url: 'https://www.imdb.com/title/tt8399141',
        criticsScore: 8,
        criticsScoreCount: 318451,
      }
    );
  });

  it('has nothing for an unrated, unknown or different title', () => {
    const unrated = {
      data: {
        title: {
          id: 'tt1',
          titleText: { text: 'New' },
          ratingsSummary: { aggregateRating: null, voteCount: 0 },
        },
      },
    };
    assert.equal(ratingFromResponse('tt1', unrated), null);
    assert.equal(ratingFromResponse('tt1', { data: { title: null } }), null);
    assert.equal(ratingFromResponse('tt2', unrated), null);
    assert.equal(
      ratingFromResponse('tt1', { errors: [{ message: 'x' }] }),
      null
    );
  });
});
