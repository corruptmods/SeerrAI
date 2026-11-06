import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIN_RATING_VOTES,
  effectiveSearchSort,
  musicBelowTitles,
  musicInAll,
  searchSort,
  searchSortsFor,
  searchType,
  sortSearchResults,
} from './searchType';

describe('the kind of search in the address', () => {
  it('is everything unless one kind is asked for', () => {
    assert.equal(searchType(undefined, true), 'all');
    assert.equal(searchType('all', true), 'all');
    assert.equal(searchType('movie', true), 'movie');
    assert.equal(searchType('tv', true), 'tv');
    assert.equal(searchType('music', true), 'music');
    assert.equal(searchType('person', true), 'person');
  });

  it('is everything when music is asked for by someone without it', () => {
    // Music unavailable to them: a shared music search link falls back to all.
    assert.equal(searchType('music', false), 'all');
  });

  it('is everything for anything it does not know', () => {
    assert.equal(searchType('collection', true), 'all');
    assert.equal(searchType(['movie', 'tv'], true), 'all');
  });
});

describe('music in All', () => {
  it('follows what an admin chose', () => {
    assert.equal(musicInAll(true, { inAll: true }), true);
    assert.equal(musicInAll(true, { inAll: false }), false);
  });

  it('is never there for someone with music off, whatever an admin chose', () => {
    // Music off globally or for the user overrides the admin's choice.
    assert.equal(musicInAll(false, { inAll: true }), false);
  });

  it('is left out when the server does not say', () => {
    assert.equal(musicInAll(true, undefined), false);
    assert.equal(musicInAll(true, {}), false);
  });
});

describe('music below the films and series', () => {
  it('comes once the films and series are there', () => {
    assert.equal(musicBelowTitles('all', true, false), false);
    assert.equal(musicBelowTitles('all', true, true), true);
  });

  it('is only for All', () => {
    assert.equal(musicBelowTitles('movie', true, true), false);
    assert.equal(musicBelowTitles('tv', true, true), false);
    // The music tab shows music alone, not below titles.
    assert.equal(musicBelowTitles('music', true, true), false);
  });

  it('is not there unless music is in All for this person', () => {
    assert.equal(musicBelowTitles('all', false, true), false);
    assert.equal(
      musicBelowTitles('all', musicInAll(false, { inAll: true }), true),
      false
    );
  });
});

describe('sorting search results', () => {
  const film = (
    id: number,
    releaseDate: string,
    voteAverage = 7,
    voteCount = 100,
    popularity = 1
  ) => ({
    id,
    mediaType: 'movie',
    releaseDate,
    voteAverage,
    voteCount,
    popularity,
  });
  const series = (id: number, firstAirDate: string, voteAverage = 7) => ({
    id,
    mediaType: 'tv',
    firstAirDate,
    voteAverage,
    voteCount: 100,
    popularity: 1,
  });
  const person = (id: number, popularity: number) => ({
    id,
    mediaType: 'person',
    popularity,
  });
  const collection = (id: number) => ({ id, mediaType: 'collection' });
  const ids = (items: { id: number }[]) => items.map((item) => item.id);

  const results = [
    collection(1),
    film(2, '2001-05-01', 6.1, 300, 12),
    series(3, '2019-09-10', 8.4),
    person(4, 40),
    film(5, '', 9.9, 2, 3),
    film(6, '2019-09-10', 7.5, 50, 25),
  ];

  it('keeps TMDB order for relevance', () => {
    assert.deepEqual(
      ids(sortSearchResults(results, 'relevance')),
      [1, 2, 3, 4, 5, 6]
    );
  });

  it('puts the newest first and undated ones after, in TMDB order', () => {
    assert.deepEqual(
      ids(sortSearchResults(results, 'newest')),
      [3, 6, 2, 1, 4, 5]
    );
  });

  it('puts the oldest first and undated ones after', () => {
    assert.deepEqual(
      ids(sortSearchResults(results, 'oldest')),
      [2, 3, 6, 1, 4, 5]
    );
  });

  it('rates only titles with enough votes, the rest after', () => {
    assert.ok(MIN_RATING_VOTES > 2);
    assert.deepEqual(
      ids(sortSearchResults(results, 'rating')),
      [3, 6, 2, 1, 4, 5]
    );
  });

  it('puts the most popular first, people included', () => {
    assert.deepEqual(
      ids(sortSearchResults(results, 'popularity')),
      [4, 6, 2, 5, 3, 1]
    );
  });

  it('offers people only the sorts they can have', () => {
    assert.deepEqual(searchSortsFor('person'), ['relevance', 'popularity']);
    assert.equal(searchSortsFor('all').length, 5);
    assert.deepEqual(searchSortsFor('music'), []);
    assert.equal(effectiveSearchSort('newest', 'person'), 'relevance');
    assert.equal(effectiveSearchSort('popularity', 'person'), 'popularity');
    assert.equal(effectiveSearchSort('rating', 'movie'), 'rating');
    assert.equal(effectiveSearchSort('rating', 'music'), 'relevance');
  });

  it('reads the sort from the address, relevance by default', () => {
    assert.equal(searchSort('newest'), 'newest');
    assert.equal(searchSort('rating'), 'rating');
    assert.equal(searchSort(undefined), 'relevance');
    assert.equal(searchSort('title'), 'relevance');
    assert.equal(searchSort(['newest', 'oldest']), 'relevance');
  });
});
