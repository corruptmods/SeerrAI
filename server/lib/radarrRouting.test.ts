import { radarrRouting } from '@server/lib/radarrRouting';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

/* Where a movie goes in Radarr, before a request's own folder or profile. */

const settings = {
  activeDirectory: '/movies',
  activeProfileId: 6,
  tags: [1],
  activeAnimeDirectory: '/anime-movies',
  activeAnimeProfileId: 9,
  animeTags: [4],
} as RadarrSettings;

// TMDB's movie shape: keywords under `keywords`.
const japaneseAnimation = {
  keywords: { keywords: [] },
  genres: [{ id: 16 }, { id: 10751 }],
  original_language: 'ja',
};
const animeKeyworded = {
  keywords: { keywords: [{ id: 210024 }] },
  genres: [{ id: 16 }],
  original_language: 'ja',
};
const westernAnimation = {
  keywords: { keywords: [] },
  genres: [{ id: 16 }],
  original_language: 'en',
};

describe('radarrRouting', () => {
  it('sends detected anime to the anime folder, profile and tags', () => {
    assert.deepEqual(radarrRouting(japaneseAnimation, settings), {
      anime: true,
      decidedBy: 'detection',
      rootFolder: '/anime-movies',
      qualityProfile: 9,
      tags: [4],
    });
    assert.equal(radarrRouting(animeKeyworded, settings).anime, true);
  });

  it('sends everything else with the usual settings', () => {
    assert.deepEqual(radarrRouting(westernAnimation, settings), {
      anime: false,
      decidedBy: 'detection',
      rootFolder: '/movies',
      qualityProfile: 6,
      tags: [1],
    });
  });

  describe('an American anime-styled film', () => {
    const americanAnimeStyle = {
      keywords: { keywords: [{ id: 210024 }] },
      genres: [{ id: 16 }],
      original_language: 'en',
      origin_country: ['US'],
    };
    afterEach(() => {
      getSettings().main.animeExcludedCountries = [];
    });

    it('goes as anime when no country is left out', () => {
      assert.equal(
        radarrRouting(americanAnimeStyle, settings).rootFolder,
        '/anime-movies'
      );
    });

    it('goes with the usual settings when American anime is left out', () => {
      getSettings().main.animeExcludedCountries = ['US'];
      assert.deepEqual(
        [
          radarrRouting(americanAnimeStyle, settings).rootFolder,
          radarrRouting(americanAnimeStyle, settings, 'anime').rootFolder,
        ],
        ['/movies', '/anime-movies']
      );
    });
  });

  it('lets anime or not chosen for the request decide either way', () => {
    const forced = radarrRouting(westernAnimation, settings, 'anime');
    assert.deepEqual(
      [
        forced.anime,
        forced.decidedBy,
        forced.rootFolder,
        forced.qualityProfile,
      ],
      [true, 'request', '/anime-movies', 9]
    );
    const unforced = radarrRouting(japaneseAnimation, settings, 'standard');
    assert.deepEqual(
      [unforced.anime, unforced.decidedBy, unforced.rootFolder],
      [false, 'request', '/movies']
    );
  });

  it("goes by the movie's own setting where the request has no choice", () => {
    const set = radarrRouting(westernAnimation, settings, null, true);
    assert.deepEqual(
      [set.anime, set.decidedBy, set.rootFolder, set.qualityProfile],
      [true, 'title', '/anime-movies', 9]
    );
    const unset = radarrRouting(japaneseAnimation, settings, 'daily', false);
    assert.deepEqual(
      [unset.anime, unset.decidedBy, unset.rootFolder],
      [false, 'title', '/movies']
    );
    const chosen = radarrRouting(japaneseAnimation, settings, 'anime', false);
    assert.deepEqual([chosen.anime, chosen.decidedBy], [true, 'request']);
  });

  it('ignores a series type a movie cannot have', () => {
    const routing = radarrRouting(japaneseAnimation, settings, 'daily');
    assert.deepEqual([routing.anime, routing.decidedBy], [true, 'detection']);
  });

  it('falls back to the usual settings where no anime ones are set', () => {
    const plain = {
      activeDirectory: '/movies',
      activeProfileId: 6,
      tags: [1],
    } as RadarrSettings;
    assert.deepEqual(radarrRouting(japaneseAnimation, plain), {
      anime: true,
      decidedBy: 'detection',
      rootFolder: '/movies',
      qualityProfile: 6,
      tags: [1],
    });
    assert.deepEqual(
      radarrRouting(japaneseAnimation, { ...settings, animeTags: [] }).tags,
      [1]
    );
  });

  it('hands out a copy of the tags, not the settings themselves', () => {
    const routing = radarrRouting(westernAnimation, settings);
    routing.tags.push(99);
    assert.deepEqual(settings.tags, [1]);
  });
});
