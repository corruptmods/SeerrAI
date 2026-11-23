import TheMovieDb from '@server/api/themoviedb';
import type { TmdbMovieDetails } from '@server/api/themoviedb/interfaces';
import { filmOut, forgetFilmDates } from '@server/lib/backfill/filmDates';
import {
  filmIsOut,
  radarrHasNoDate,
  tmdbFilmDate,
} from '@server/lib/backfill/plan';
import type { RadarrMovieDetail } from '@server/lib/backfill/radarr';
import { BACKFILL_DEFAULTS, getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

/*
 * A film Radarr has no date for (made for TV: TMDB gives it only a TV
 * release) is never available to Radarr. Backfill goes by TMDB's date then,
 * with the same new-release wait, asking TMDB once a day at most.
 */

const HOUR = 60 * 60 * 1000;

const HARBOUR: RadarrMovieDetail = {
  id: 811,
  title: 'Harbour Lights',
  year: 2004,
  tmdbId: 990811,
  path: '/movies/Harbour Lights (2004)',
  qualityProfileId: 6,
  monitored: true,
  isAvailable: false,
  minimumAvailability: 'released',
  hasFile: false,
  movieFileId: 0,
};

type Details = Partial<Pick<TmdbMovieDetails, 'release_date' | 'status'>> & {
  release_dates?: {
    results: {
      iso_3166_1: string;
      rating: string;
      release_dates: {
        certification: string;
        release_date: string;
        type: number;
      }[];
    }[];
  };
};

const tvOnly = (date: string): Details => ({
  release_date: '',
  release_dates: {
    results: [
      {
        iso_3166_1: 'US',
        rating: '',
        release_dates: [{ certification: '', release_date: date, type: 6 }],
      },
    ],
  },
});

let details: Details = {};
let asked: number[] = [];

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async ({ movieId }: { movieId: number }) => {
      asked.push(movieId);
      return details;
    };
  },
  set() {},
  configurable: true,
});

after(() => {
  delete (TheMovieDb.prototype as unknown as { getMovie?: unknown }).getMovie;
});

beforeEach(() => {
  forgetFilmDates();
  details = {};
  asked = [];
  getSettings().backfill = { ...BACKFILL_DEFAULTS, newReleaseWaitHours: 12 };
});

describe('Backfill: films Radarr has no date for', () => {
  it('knows when Radarr counts a film as not out only for want of a date', () => {
    assert.equal(radarrHasNoDate(HARBOUR), true);
    assert.equal(
      radarrHasNoDate({ ...HARBOUR, digitalRelease: '2030-01-01T00:00:00Z' }),
      false,
      'a date still to come: not out, and rightly'
    );
    assert.equal(
      radarrHasNoDate({ ...HARBOUR, inCinemas: '2004-03-12T00:00:00Z' }),
      false,
      'Radarr goes by its cinema date'
    );
    assert.equal(radarrHasNoDate({ ...HARBOUR, isAvailable: true }), false);
    assert.equal(
      radarrHasNoDate({ ...HARBOUR, minimumAvailability: 'announced' }),
      false
    );
  });

  it('takes TMDB’s earliest TV, digital or physical release, else its primary date', () => {
    assert.deepEqual(tmdbFilmDate(tvOnly('2004-03-12T00:00:00.000Z')), {
      date: '2004-03-12T00:00:00.000Z',
      kind: 'tv',
    });
    assert.deepEqual(
      tmdbFilmDate({
        release_date: '2004-03-01',
        release_dates: {
          results: [
            {
              release_dates: [
                { release_date: '2004-06-01T00:00:00.000Z', type: 5 },
                { release_date: '2004-01-01T00:00:00.000Z', type: 3 },
              ],
            },
            {
              release_dates: [
                { release_date: '2004-04-01T00:00:00.000Z', type: 4 },
              ],
            },
          ],
        },
      }),
      { date: '2004-04-01T00:00:00.000Z', kind: 'digital' },
      'a cinema release is Radarr’s to have; not counted here'
    );
    assert.deepEqual(
      tmdbFilmDate({ release_date: '2004-03-12', status: 'Released' }),
      { date: '2004-03-12T00:00:00.000Z', kind: 'primary' },
      'released, and no typed dates at all'
    );
    assert.equal(
      tmdbFilmDate({ release_date: '', status: 'Released' }),
      undefined
    );
  });

  it('goes by the primary date only for a released film made for TV or with no typed dates', () => {
    const typed = (...rows: { type: number; release_date: string }[]) => ({
      results: [{ release_dates: rows }],
    });
    const at = (days: number) =>
      new Date(Date.now() + days * 24 * HOUR).toISOString();
    // A festival premiere only: not out anywhere yet.
    assert.equal(
      tmdbFilmDate({
        release_date: '2004-03-12',
        status: 'Released',
        release_dates: typed({ type: 1, release_date: '2004-03-12' }),
      }),
      undefined
    );
    assert.equal(
      tmdbFilmDate({
        release_date: '2004-03-12',
        status: 'Released',
        genres: [{ id: 10770 }],
        release_dates: typed({ type: 1, release_date: '2004-03-12' }),
      }),
      undefined,
      'made for TV, but only premiered'
    );
    // Cinema dates still to come.
    assert.equal(
      tmdbFilmDate({
        release_date: '2004-03-12',
        status: 'Released',
        release_dates: typed(
          { type: 1, release_date: '2004-03-12' },
          { type: 3, release_date: at(30) }
        ),
      }),
      undefined
    );
    // Not released, by TMDB's word.
    assert.equal(
      tmdbFilmDate({ release_date: '2004-03-12', status: 'Post Production' }),
      undefined
    );
    assert.equal(tmdbFilmDate({ release_date: '2004-03-12' }), undefined);
    // Made for TV, with a past cinema date Radarr didn't take.
    assert.deepEqual(
      tmdbFilmDate({
        release_date: '2004-03-12',
        status: 'Released',
        genres: [{ id: 18 }, { id: 10770 }],
        release_dates: typed({ type: 3, release_date: at(-400) }),
      }),
      { date: '2004-03-12T00:00:00.000Z', kind: 'primary' }
    );
    // Not made for TV, with typed dates that aren't TV, digital or physical.
    assert.equal(
      tmdbFilmDate({
        release_date: '2004-03-12',
        status: 'Released',
        release_dates: typed({ type: 3, release_date: at(-400) }),
      }),
      undefined
    );
  });

  it('leaves a film with only a festival premiere not out', async () => {
    details = {
      release_date: '2004-03-12',
      status: 'Released',
      release_dates: {
        results: [
          {
            iso_3166_1: 'FR',
            rating: '',
            release_dates: [
              { certification: '', release_date: '2004-03-12', type: 1 },
            ],
          },
        ],
      },
    };
    assert.deepEqual(await filmOut(HARBOUR), { out: false, tmdb: undefined });
  });

  it('counts the film out by TMDB’s date, after the new-release wait', () => {
    const at = (hours: number) =>
      new Date(Date.now() - hours * HOUR).toISOString();
    assert.equal(filmIsOut(HARBOUR, at(13)), true);
    assert.equal(filmIsOut(HARBOUR, at(2)), false, 'still Radarr’s');
    assert.equal(filmIsOut(HARBOUR, undefined), false);
    assert.equal(
      filmIsOut(
        { ...HARBOUR, digitalRelease: at(-48) },
        '2004-03-12T00:00:00.000Z'
      ),
      false,
      'Radarr has a date: its verdict stands'
    );
    assert.equal(
      filmIsOut({ ...HARBOUR, isAvailable: true, releaseDate: at(13) }),
      true
    );
  });

  it('asks TMDB only for such a film, and once a day', async () => {
    details = tvOnly('2004-03-12T00:00:00.000Z');
    const first = await filmOut(HARBOUR);
    assert.equal(first.out, true);
    assert.deepEqual(first.tmdb, {
      date: '2004-03-12T00:00:00.000Z',
      kind: 'tv',
    });
    await filmOut(HARBOUR);
    assert.deepEqual(asked, [HARBOUR.tmdbId], 'kept for a day');

    asked = [];
    assert.equal(
      (await filmOut({ ...HARBOUR, isAvailable: true })).out,
      true,
      'Radarr says it is out'
    );
    assert.equal(
      (await filmOut({ ...HARBOUR, digitalRelease: '2099-01-01T00:00:00Z' }))
        .out,
      false
    );
    assert.equal(
      (await filmOut({ ...HARBOUR, tmdbId: 990812, year: 2999 })).out,
      false,
      'a year still to come'
    );
    assert.deepEqual(asked, [], 'TMDB was not asked for any of them');
  });

  it('leaves the film not out when TMDB has no date either', async () => {
    details = { release_date: '' };
    assert.deepEqual(await filmOut(HARBOUR), { out: false, tmdb: undefined });
  });
});
