import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  musicBelowTitles,
  musicSearchPlaces,
  searchFindsMusic,
  searchType,
} from './searchType';

describe('the kind of search in the address', () => {
  it('is everything unless one kind is asked for', () => {
    assert.equal(searchType(undefined, true), 'all');
    assert.equal(searchType('all', true), 'all');
    assert.equal(searchType('movie', true), 'movie');
    assert.equal(searchType('tv', true), 'tv');
    assert.equal(searchType('music', true), 'music');
  });

  it('is everything when music is asked for by someone without it', () => {
    // Off for everyone, off for themselves, no Lidarr yet, or an admin
    // took Music off the search page: a shared link to music search shows
    // them films and series instead.
    assert.equal(searchType('music', false), 'all');
  });

  it('is everything for anything it does not know', () => {
    assert.equal(searchType('person', true), 'all');
    assert.equal(searchType(['movie', 'tv'], true), 'all');
  });
});

describe('where someone can search music', () => {
  it('follows what an admin chose', () => {
    assert.deepEqual(
      musicSearchPlaces(true, { inAll: true, musicPage: false, chip: true }),
      { inAll: true, musicPage: false, chip: true }
    );
    assert.deepEqual(
      musicSearchPlaces(true, { inAll: false, musicPage: true, chip: false }),
      { inAll: false, musicPage: true, chip: false }
    );
  });

  it('is nowhere for someone with music off, whatever an admin chose', () => {
    // Off for everyone, or off for themselves: theirs wins.
    assert.deepEqual(
      musicSearchPlaces(false, { inAll: true, musicPage: true, chip: true }),
      { inAll: false, musicPage: false, chip: false }
    );
  });

  it('is as it always was when the server does not say', () => {
    assert.deepEqual(musicSearchPlaces(true, undefined), {
      inAll: false,
      musicPage: true,
      chip: true,
    });
  });
});

describe('music below the films and series', () => {
  const inAll = musicSearchPlaces(true, {
    inAll: true,
    musicPage: true,
    chip: true,
  });

  it('comes once the films and series are there', () => {
    assert.equal(musicBelowTitles('all', inAll, false), false);
    assert.equal(musicBelowTitles('all', inAll, true), true);
  });

  it('is only for All', () => {
    assert.equal(musicBelowTitles('movie', inAll, true), false);
    assert.equal(musicBelowTitles('tv', inAll, true), false);
    // Music shows music on its own, not as rows below anything.
    assert.equal(musicBelowTitles('music', inAll, true), false);
  });

  it('is not there unless an admin chose it, or with music off', () => {
    assert.equal(
      musicBelowTitles('all', musicSearchPlaces(true, undefined), true),
      false
    );
    assert.equal(
      musicBelowTitles(
        'all',
        musicSearchPlaces(false, { inAll: true, musicPage: true, chip: true }),
        true
      ),
      false
    );
  });
});

describe('whether the search box finds music', () => {
  it('does when Music is a choice, or music comes below All', () => {
    const chosen = (inAll: boolean, chip: boolean) =>
      musicSearchPlaces(true, { inAll, musicPage: true, chip });
    assert.equal(searchFindsMusic(chosen(false, true)), true);
    assert.equal(searchFindsMusic(chosen(true, false)), true);
    // The Music page's own box is not the search box at the top.
    assert.equal(searchFindsMusic(chosen(false, false)), false);
  });

  it('does not for someone with music off', () => {
    assert.equal(
      searchFindsMusic(
        musicSearchPlaces(false, { inAll: true, musicPage: true, chip: true })
      ),
      false
    );
  });
});
