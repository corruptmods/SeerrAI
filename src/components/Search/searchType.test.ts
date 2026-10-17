import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { musicBelowTitles, musicInAll, searchType } from './searchType';

describe('the kind of search in the address', () => {
  it('is everything unless one kind is asked for', () => {
    assert.equal(searchType(undefined, true), 'all');
    assert.equal(searchType('all', true), 'all');
    assert.equal(searchType('movie', true), 'movie');
    assert.equal(searchType('tv', true), 'tv');
    assert.equal(searchType('music', true), 'music');
  });

  it('is everything when music is asked for by someone without it', () => {
    // Off for everyone, off for themselves, or no Lidarr yet: a shared
    // link to music search shows them films and series instead.
    assert.equal(searchType('music', false), 'all');
  });

  it('is everything for anything it does not know', () => {
    assert.equal(searchType('person', true), 'all');
    assert.equal(searchType(['movie', 'tv'], true), 'all');
  });
});

describe('music in All', () => {
  it('follows what an admin chose', () => {
    assert.equal(musicInAll(true, { inAll: true }), true);
    assert.equal(musicInAll(true, { inAll: false }), false);
  });

  it('is never there for someone with music off, whatever an admin chose', () => {
    // Off for everyone, or off for themselves: theirs wins.
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
    // Music shows music on its own, not as rows below anything.
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
