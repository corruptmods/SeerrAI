import { radarrRouting } from '@server/lib/radarrRouting';
import type { RadarrSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
const spiritedAway = {
  keywords: { keywords: [] },
  genres: [{ id: 16 }, { id: 10751 }],
  original_language: 'ja',
};
const yourName = {
  keywords: { keywords: [{ id: 210024 }] },
  genres: [{ id: 16 }],
  original_language: 'ja',
};
const theWildRobot = {
  keywords: { keywords: [] },
  genres: [{ id: 16 }],
  original_language: 'en',
};

describe('radarrRouting', () => {
  it('sends detected anime to the anime folder, profile and tags', () => {
    assert.deepEqual(radarrRouting(spiritedAway, settings), {
      anime: true,
      decidedBy: 'detection',
      rootFolder: '/anime-movies',
      qualityProfile: 9,
      tags: [4],
    });
    assert.equal(radarrRouting(yourName, settings).anime, true);
  });

  it('sends everything else with the usual settings', () => {
    assert.deepEqual(radarrRouting(theWildRobot, settings), {
      anime: false,
      decidedBy: 'detection',
      rootFolder: '/movies',
      qualityProfile: 6,
      tags: [1],
    });
  });

  it('sends American titles with the usual settings, anime keyword or not', () => {
    const americanAnimeStyle = {
      keywords: { keywords: [{ id: 210024 }] },
      genres: [{ id: 16 }],
      original_language: 'en',
      origin_country: ['US'],
    };
    assert.deepEqual(
      [
        radarrRouting(americanAnimeStyle, settings).rootFolder,
        radarrRouting(americanAnimeStyle, settings, 'anime').rootFolder,
      ],
      ['/movies', '/anime-movies']
    );
  });

  it('lets anime or not chosen for the request decide either way', () => {
    const forced = radarrRouting(theWildRobot, settings, 'anime');
    assert.deepEqual(
      [
        forced.anime,
        forced.decidedBy,
        forced.rootFolder,
        forced.qualityProfile,
      ],
      [true, 'request', '/anime-movies', 9]
    );
    const unforced = radarrRouting(spiritedAway, settings, 'standard');
    assert.deepEqual(
      [unforced.anime, unforced.decidedBy, unforced.rootFolder],
      [false, 'request', '/movies']
    );
  });

  it("goes by the movie's own setting where the request has no choice", () => {
    const set = radarrRouting(theWildRobot, settings, null, true);
    assert.deepEqual(
      [set.anime, set.decidedBy, set.rootFolder, set.qualityProfile],
      [true, 'title', '/anime-movies', 9]
    );
    const unset = radarrRouting(spiritedAway, settings, 'daily', false);
    assert.deepEqual(
      [unset.anime, unset.decidedBy, unset.rootFolder],
      [false, 'title', '/movies']
    );
    const chosen = radarrRouting(spiritedAway, settings, 'anime', false);
    assert.deepEqual([chosen.anime, chosen.decidedBy], [true, 'request']);
  });

  it('ignores a series type a movie cannot have', () => {
    const routing = radarrRouting(spiritedAway, settings, 'daily');
    assert.deepEqual([routing.anime, routing.decidedBy], [true, 'detection']);
  });

  it('falls back to the usual settings where no anime ones are set', () => {
    const plain = {
      activeDirectory: '/movies',
      activeProfileId: 6,
      tags: [1],
    } as RadarrSettings;
    assert.deepEqual(radarrRouting(spiritedAway, plain), {
      anime: true,
      decidedBy: 'detection',
      rootFolder: '/movies',
      qualityProfile: 6,
      tags: [1],
    });
    assert.deepEqual(
      radarrRouting(spiritedAway, { ...settings, animeTags: [] }).tags,
      [1]
    );
  });

  it('hands out a copy of the tags, not the settings themselves', () => {
    const routing = radarrRouting(theWildRobot, settings);
    routing.tags.push(99);
    assert.deepEqual(settings.tags, [1]);
  });
});
