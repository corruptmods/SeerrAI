import { isAnime, leftOutAsAnime } from '@server/utils/isAnime';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * What counts as anime, in each shape a title arrives in, and with the
 * admin's list of countries whose anime is left out (Settings → Services).
 */

const ANIMATION = { id: 16, name: 'Animation' };
const DRAMA = { id: 18, name: 'Drama' };
const ANIME_KEYWORD = { id: 210024, name: 'anime' };

// Castlevania: American, in English, with TMDB's anime keyword.
const castlevania = {
  keywords: { results: [ANIME_KEYWORD] },
  genres: [ANIMATION],
  original_language: 'en',
  origin_country: ['US'],
};

describe('isAnime', () => {
  it('counts the anime keyword on its own, whatever else is set', () => {
    assert.equal(
      isAnime(
        {
          keywords: { results: [ANIME_KEYWORD] },
          genres: [DRAMA],
          original_language: 'en',
          origin_country: ['JP'],
        },
        []
      ),
      true
    );
  });

  it('counts anime from every country when none is left out', () => {
    assert.equal(isAnime(castlevania, []), true);
    // Korean, with the keyword.
    assert.equal(
      isAnime(
        {
          keywords: { results: [ANIME_KEYWORD] },
          genres: [ANIMATION],
          original_language: 'ko',
          origin_country: ['KR'],
        },
        []
      ),
      true
    );
  });

  it('leaves out a country the admin listed, unless it is in Japanese', () => {
    assert.equal(isAnime(castlevania, ['US']), false);
    // A movie, known only by where it was produced.
    assert.equal(
      isAnime(
        {
          keywords: { keywords: [ANIME_KEYWORD] },
          genres: [ANIMATION],
          original_language: 'en',
          production_countries: [{ iso_3166_1: 'US' }, { iso_3166_1: 'JP' }],
        },
        ['US']
      ),
      false
    );
    // The app's shape.
    assert.equal(
      isAnime(
        {
          keywords: [ANIME_KEYWORD],
          originalLanguage: 'en',
          originCountry: ['US'],
        },
        ['US']
      ),
      false
    );
    // Uzumaki: an American co-production made in Japanese.
    assert.equal(
      isAnime(
        {
          keywords: { results: [ANIME_KEYWORD] },
          genres: [ANIMATION],
          original_language: 'ja',
          origin_country: ['US', 'JP'],
        },
        ['US']
      ),
      true
    );
    // Only the countries listed are left out.
    assert.equal(isAnime(castlevania, ['KR', 'CN']), true);
    assert.equal(
      isAnime(
        {
          keywords: { results: [ANIME_KEYWORD] },
          original_language: 'ko',
          origin_country: ['KR'],
        },
        ['KR', 'CN']
      ),
      false
    );
  });

  it('goes by the origin countries before where a title was produced', () => {
    // Made in Japan in English, with an American studio among producers.
    assert.equal(
      isAnime(
        {
          keywords: { results: [ANIME_KEYWORD] },
          original_language: 'en',
          origin_country: ['JP'],
          production_countries: [{ iso_3166_1: 'US' }],
        },
        ['US']
      ),
      true
    );
  });

  it('counts Japanese animation without the keyword', () => {
    // Oshi no Ko: no anime keyword on TMDB at the time.
    assert.equal(
      isAnime(
        {
          keywords: { results: [] },
          genres: [ANIMATION, DRAMA],
          original_language: 'ja',
        },
        []
      ),
      true
    );
  });

  it('does not count animation in other languages, or Japanese live action', () => {
    for (const language of ['ko', 'zh', 'en']) {
      assert.equal(
        isAnime(
          {
            keywords: { results: [] },
            genres: [ANIMATION],
            original_language: language,
          },
          []
        ),
        false,
        language
      );
    }
    assert.equal(
      isAnime(
        {
          keywords: { results: [] },
          genres: [DRAMA],
          original_language: 'ja',
        },
        []
      ),
      false
    );
  });

  it("reads the app's own shape and a movie's keywords too", () => {
    assert.equal(
      isAnime(
        {
          keywords: [],
          genres: [ANIMATION],
          originalLanguage: 'ja',
        },
        []
      ),
      true
    );
    assert.equal(isAnime({ keywords: [ANIME_KEYWORD] }, []), true);
    assert.equal(
      isAnime({ keywords: { keywords: [ANIME_KEYWORD] } }, []),
      true
    );
    assert.equal(isAnime({}, []), false);
  });
});

describe('leftOutAsAnime', () => {
  it('is true only for a title not in Japanese from a listed country', () => {
    assert.equal(leftOutAsAnime(castlevania, ['US']), true);
    assert.equal(leftOutAsAnime(castlevania, []), false);
    assert.equal(
      leftOutAsAnime({ original_language: 'ja', origin_country: ['US'] }, [
        'US',
      ]),
      false
    );
    // Nothing known of where it was made: nothing to leave out.
    assert.equal(leftOutAsAnime({ original_language: 'en' }, ['US']), false);
  });
});
