import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { sonarrRouting } from '@server/lib/sonarrRouting';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

/* Where a series goes in Sonarr, before a request's own folder or profile. */

const settings = {
  activeDirectory: '/tv',
  activeProfileId: 1,
  activeLanguageProfileId: 1,
  tags: [1],
  seriesType: 'standard',
  activeAnimeDirectory: '/anime',
  activeAnimeProfileId: 7,
  activeAnimeLanguageProfileId: 3,
  animeTags: [9],
  animeSeriesType: 'anime',
} as SonarrSettings;

const japaneseSeries = {
  keywords: { results: [] },
  genres: [{ id: 16 }, { id: 18 }],
  original_language: 'ja',
};
const koreanAnimation = {
  keywords: { results: [] },
  genres: [{ id: 16 }],
  original_language: 'ko',
};

// With anime on (Settings → Services → Anime); the switch has its own tests.
beforeEach(() => {
  getSettings().main.anime = 'on';
  getSettings().sonarr = [];
  getSettings().radarr = [];
});

afterEach(() => {
  getSettings().main.anime = 'auto';
  getSettings().sonarr = [];
});

describe('sonarrRouting', () => {
  it('sends detected anime to the anime folder, profiles, tags and type', () => {
    assert.deepEqual(sonarrRouting(japaneseSeries, settings), {
      anime: true,
      decidedBy: 'detection',
      seriesType: 'anime',
      rootFolder: '/anime',
      qualityProfile: 7,
      languageProfile: 3,
      tags: [9],
    });
  });

  it('sends everything else with the standard settings', () => {
    assert.deepEqual(sonarrRouting(koreanAnimation, settings), {
      anime: false,
      decidedBy: 'detection',
      seriesType: 'standard',
      rootFolder: '/tv',
      qualityProfile: 1,
      languageProfile: 1,
      tags: [1],
    });
  });

  it('lets a series type chosen for the request decide either way', () => {
    const forced = sonarrRouting(koreanAnimation, settings, 'anime');
    assert.deepEqual(
      [forced.anime, forced.decidedBy, forced.seriesType, forced.rootFolder],
      [true, 'request', 'anime', '/anime']
    );
    const standard = sonarrRouting(japaneseSeries, settings, 'standard');
    assert.deepEqual(
      [standard.anime, standard.seriesType, standard.rootFolder],
      [false, 'standard', '/tv']
    );
  });

  it("goes by the title's own setting where the request has no type", () => {
    const set = sonarrRouting(koreanAnimation, settings, null, true);
    assert.deepEqual(
      [set.anime, set.decidedBy, set.seriesType, set.rootFolder],
      [true, 'title', 'anime', '/anime']
    );
    const unset = sonarrRouting(japaneseSeries, settings, null, false);
    assert.deepEqual(
      [unset.anime, unset.decidedBy, unset.seriesType, unset.qualityProfile],
      [false, 'title', 'standard', 1]
    );
    assert.equal(
      sonarrRouting(japaneseSeries, settings, null, null).decidedBy,
      'detection'
    );
  });

  it("lets the request's own type stand over the title's setting", () => {
    const chosen = sonarrRouting(koreanAnimation, settings, 'standard', true);
    assert.deepEqual(
      [chosen.anime, chosen.decidedBy, chosen.seriesType, chosen.rootFolder],
      [false, 'request', 'standard', '/tv']
    );
    assert.equal(
      sonarrRouting(japaneseSeries, settings, 'daily', false).seriesType,
      'daily'
    );
  });

  it('falls back to the standard folder and profiles until anime ones are set', () => {
    const bare = {
      ...settings,
      activeAnimeDirectory: undefined,
      activeAnimeProfileId: undefined,
      activeAnimeLanguageProfileId: undefined,
      animeTags: undefined,
    } as unknown as SonarrSettings;
    assert.deepEqual(sonarrRouting(japaneseSeries, bare), {
      anime: true,
      decidedBy: 'detection',
      seriesType: 'anime',
      rootFolder: '/tv',
      qualityProfile: 1,
      languageProfile: 1,
      tags: [],
    });
  });
});

describe('sonarrRouting with the anime switch', () => {
  const standard = {
    anime: false,
    decidedBy: 'off',
    seriesType: 'standard',
    rootFolder: '/tv',
    qualityProfile: 1,
    languageProfile: 1,
    tags: [1],
  };

  it('sends everything as standard while anime is off, whatever the request or title says', () => {
    getSettings().main.anime = 'off';
    assert.deepEqual(sonarrRouting(japaneseSeries, settings), standard);
    assert.deepEqual(
      sonarrRouting(japaneseSeries, settings, 'anime', true),
      standard
    );
    assert.deepEqual(
      sonarrRouting(koreanAnimation, settings, null, true),
      standard
    );
  });

  it("keeps a daily type while anime is off, and the server's own standard type", () => {
    getSettings().main.anime = 'off';
    assert.equal(
      sonarrRouting(japaneseSeries, settings, 'daily').seriesType,
      'daily'
    );
    // A Sonarr that types every series as anime keeps doing so.
    const allAnime = { ...settings, seriesType: 'anime' } as SonarrSettings;
    assert.equal(sonarrRouting(japaneseSeries, allAnime).seriesType, 'anime');
  });

  it('is on when switched on, with no anime library anywhere', () => {
    getSettings().main.anime = 'on';
    assert.equal(sonarrRouting(japaneseSeries, settings).rootFolder, '/anime');
  });

  it('follows the servers in auto: off with no anime library, on with one', () => {
    getSettings().main.anime = 'auto';
    // Sonarr's anime series type alone doesn't make an anime library.
    getSettings().sonarr = [
      {
        ...settings,
        activeAnimeDirectory: undefined,
        activeAnimeProfileId: undefined,
        animeTags: [],
        animeSeriesType: 'anime',
      } as unknown as SonarrSettings,
    ];
    assert.deepEqual(sonarrRouting(japaneseSeries, settings), standard);

    getSettings().sonarr = [settings];
    assert.deepEqual(sonarrRouting(japaneseSeries, settings), {
      anime: true,
      decidedBy: 'detection',
      seriesType: 'anime',
      rootFolder: '/anime',
      qualityProfile: 7,
      languageProfile: 3,
      tags: [9],
    });
  });
});
