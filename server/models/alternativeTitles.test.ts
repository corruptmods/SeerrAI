import { mapAlternativeTitles } from '@server/models/common';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('alternative titles', () => {
  it('lists each other name once, with every country, leaving out the shown ones', () => {
    assert.deepEqual(
      mapAlternativeTitles(
        [
          { iso_3166_1: 'GB', title: 'Harbour Lights' },
          { iso_3166_1: 'FR', title: 'Les Feux du Port' },
          { iso_3166_1: 'BE', title: 'les feux du port ' },
          { iso_3166_1: 'US', title: 'Lantern Song' },
          { iso_3166_1: 'CA', title: '' },
        ],
        ['Lantern Song', undefined, 'harbour lights']
      ),
      [{ title: 'Les Feux du Port', countries: ['FR', 'BE'] }]
    );
    assert.deepEqual(mapAlternativeTitles(undefined, ['x']), []);
  });
});
