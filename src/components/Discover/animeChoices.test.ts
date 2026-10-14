import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  animeQuery,
  choiceSeason,
  readAnimeChoice,
  readAnimeCountry,
} from './animeChoices';

/*
 * The Anime page's choices, as the page asks the server for them: seasons
 * are counted from the day the person is looking.
 */

// 13 October 2026: Fall.
const today = new Date(2026, 9, 13);

describe('the Anime page', () => {
  it('shows the series airing this season', () => {
    assert.deepEqual(animeQuery('this', today), {
      show: 'airing',
      season: '2026-fall',
    });
  });

  it("shows next season's premieres, into the new year", () => {
    assert.deepEqual(animeQuery('next', today), {
      show: 'premieres',
      season: '2027-winter',
    });
  });

  it('shows what aired last season', () => {
    assert.deepEqual(animeQuery('last', today), {
      show: 'airing',
      season: '2026-summer',
    });
  });

  it('shows popular series and films whatever the season', () => {
    assert.deepEqual(animeQuery('popular', today), { show: 'popular' });
    assert.deepEqual(animeQuery('films', today), { show: 'films' });
  });

  it('names the season each seasonal choice is for', () => {
    assert.deepEqual(choiceSeason('this', today), {
      year: 2026,
      name: 'fall',
    });
    assert.deepEqual(choiceSeason('last', today), {
      year: 2026,
      name: 'summer',
    });
    assert.equal(choiceSeason('films', today), null);
  });

  it('starts on this season for anything it does not recognise', () => {
    assert.equal(readAnimeChoice(undefined), 'this');
    assert.equal(readAnimeChoice('winter'), 'this');
    assert.equal(readAnimeChoice(['next', 'last']), 'this');
    assert.equal(readAnimeChoice('next'), 'next');
    assert.equal(readAnimeChoice('films'), 'films');
  });

  it('narrows to the country chosen, with any choice', () => {
    assert.deepEqual(animeQuery('this', today, 'KR'), {
      show: 'airing',
      season: '2026-fall',
      country: 'KR',
    });
    assert.deepEqual(animeQuery('films', today, 'JP'), {
      show: 'films',
      country: 'JP',
    });
  });

  it('reads a country from the address, or every country for anything else', () => {
    assert.equal(readAnimeCountry('kr'), 'KR');
    assert.equal(readAnimeCountry('FR'), 'FR');
    assert.equal(readAnimeCountry(undefined), undefined);
    assert.equal(readAnimeCountry('Japan'), undefined);
    assert.equal(readAnimeCountry(['JP', 'KR']), undefined);
  });
});
