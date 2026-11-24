import type {
  TmdbTvDetails,
  TmdbTvSeasonResult,
} from '@server/api/themoviedb/interfaces';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaLibraryItem from '@server/entity/MediaLibraryItem';
import SiloEpisode from '@server/entity/SiloEpisode';
import availabilitySync from '@server/lib/availabilitySync';
import { runDbMaintenance } from '@server/lib/dbMaintenance';
import { SiloScanner } from '@server/lib/scanners/silo';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import {
  createFakeSilo,
  siloEpisode,
  siloMovie,
  siloSeries,
} from '@server/test/fakeSilo';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Silo's full and recently added scans, availability sync and the nightly
 * clean-up of its episode list, against a stand-in Silo.
 */

setupTestDb();

const silo = createFakeSilo();

const season = (number: number, count: number): TmdbTvSeasonResult => ({
  id: number,
  air_date: '2024-01-01',
  episode_count: count,
  name: `Season ${number}`,
  overview: '',
  season_number: number,
});

const shows = new Map<number, TmdbTvDetails>();
const tvdbToTmdb = new Map<number, number>();

const fakeShow = (
  id: number,
  name: string,
  seasons: TmdbTvSeasonResult[]
): TmdbTvDetails =>
  ({
    id,
    name,
    original_name: name,
    seasons,
    genres: [],
    keywords: { results: [] },
    origin_country: ['GB'],
    original_language: 'en',
    external_ids: {},
    content_ratings: { results: [] },
  }) as unknown as TmdbTvDetails;

/** A scanner that doesn't pause between batches, with TMDB stubbed. */
const scanner = (isRecentOnly = false) => {
  const made = new SiloScanner({ isRecentOnly, updateRate: 0 });
  Object.defineProperty(made.tmdb, 'getTvShowForScan', {
    value: async ({ tvId }: { tvId: number }) => {
      const show = shows.get(tvId);
      if (!show) throw new Error('not found');
      return show;
    },
    configurable: true,
  });
  Object.defineProperty(made.tmdb, 'getShowByTvdbIdForScan', {
    value: async ({ tvdbId }: { tvdbId: number }) => {
      const show = shows.get(tvdbToTmdb.get(tvdbId) ?? 0);
      if (!show) throw new Error('not found');
      return show;
    },
    configurable: true,
  });
  return made;
};

const media = (tmdbId: number, mediaType: MediaType) =>
  getRepository(Media).findOneOrFail({
    where: { tmdbId, mediaType },
    relations: { seasons: true },
  });

const radarr4k = {
  id: 9,
  is4k: true,
  isDefault: true,
} as unknown as RadarrSettings;
const sonarr4k = {
  id: 9,
  is4k: true,
  isDefault: true,
} as unknown as SonarrSettings;

before(() => silo.start());
after(() => silo.stop());

beforeEach(() => {
  silo.reset();
  shows.clear();
  tvdbToTmdb.clear();
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.SILO;
  settings.main.enableSpecialEpisodes = false;
  settings.plex.connected = false;
  settings.jellyfin.connected = false;
  settings.emby.connected = false;
  settings.radarr = [];
  settings.sonarr = [];
  settings.silo = silo.settings({
    libraries: [
      { id: '1', name: 'Films', enabled: true, type: 'movie' },
      { id: '2', name: 'Series', enabled: true, type: 'show' },
      { id: '3', name: 'Everything', enabled: true, type: 'mixed' },
      { id: '9', name: 'Old Films', enabled: false, type: 'movie' },
    ],
  });
});

describe('the Silo full scan', () => {
  it('makes films available with their quality, and skips libraries turned off', async () => {
    silo.items = [
      siloMovie('movie-tmdb-9101', {
        tmdbId: 9101,
        resolutions: ['1080p'],
        ranges: ['hdr10'],
      }),
      siloMovie('movie-tmdb-9102', {
        tmdbId: 9102,
        libraryId: '9',
        title: 'Lantern Song',
      }),
      siloMovie('movie-untagged', { title: 'Harbour Lights' }),
    ];
    await scanner().run();

    const glasswing = await media(9101, MediaType.MOVIE);
    assert.equal(glasswing.status, MediaStatus.AVAILABLE);
    assert.equal(glasswing.siloMediaId, 'movie-tmdb-9101');
    assert.deepEqual(glasswing.quality?.silo?.standard, {
      resolutions: ['1080p'],
      ranges: ['HDR10'],
    });
    assert.equal(
      await getRepository(Media).countBy({ tmdbId: 9102 }),
      0,
      'a library turned off is not scanned'
    );
    const placed = await getRepository(MediaLibraryItem).findBy({
      server: 'silo',
    });
    assert.deepEqual(
      placed.map((row) => [row.libraryId, row.itemId]),
      [['1', 'movie-tmdb-9101']]
    );
    assert.ok(getSettings().silo.libraries[0].lastScan);
  });

  it('keeps 4K apart while a 4K Radarr exists', async () => {
    getSettings().radarr = [radarr4k];
    silo.items = [
      siloMovie('movie-tmdb-9103', {
        tmdbId: 9103,
        resolutions: ['2160p', '1080p'],
        ranges: ['dolby_vision', 'hdr_unknown'],
      }),
    ];
    await scanner().run();
    const movie = await media(9103, MediaType.MOVIE);
    assert.equal(movie.status, MediaStatus.AVAILABLE);
    assert.equal(movie.status4k, MediaStatus.AVAILABLE);
    assert.equal(movie.siloMediaId4k, 'movie-tmdb-9103');
    assert.deepEqual(movie.quality?.silo?.['4k'], {
      resolutions: ['4K'],
      ranges: ['DV'],
    });
    // hdr_unknown says nothing, so no HDR badge from it.
    assert.deepEqual(movie.quality?.silo?.standard, {
      resolutions: ['1080p'],
    });
  });

  it('counts series seasons from their episodes, found by TVDB id too', async () => {
    shows.set(
      9201,
      fakeShow(9201, 'Static Garden', [season(1, 3), season(2, 2)])
    );
    tvdbToTmdb.set(77001, 9201);
    silo.items = [
      siloSeries('series-tvdb-77001', { tvdbId: 77001 }),
      siloEpisode('series-tvdb-77001', 1, 1),
      siloEpisode('series-tvdb-77001', 1, 2),
      siloEpisode('series-tvdb-77001', 1, 3),
      siloEpisode('series-tvdb-77001', 2, 1),
    ];
    await scanner().run();
    const show = await media(9201, MediaType.TV);
    const byNumber = (n: number) =>
      show.seasons.find((s) => s.seasonNumber === n)?.status;
    assert.equal(byNumber(1), MediaStatus.AVAILABLE);
    assert.equal(byNumber(2), MediaStatus.PARTIALLY_AVAILABLE);
    assert.equal(show.status, MediaStatus.PARTIALLY_AVAILABLE);
    assert.equal(show.siloMediaId, 'series-tvdb-77001');
    assert.equal(await getRepository(SiloEpisode).count(), 4);
  });

  it('reads films and series from a mixed library', async () => {
    shows.set(9202, fakeShow(9202, 'Harbour Lights', [season(1, 1)]));
    silo.items = [
      siloMovie('movie-tmdb-9104', { tmdbId: 9104, libraryId: '3' }),
      siloSeries('series-tmdb-9202', { tmdbId: 9202, libraryId: '3' }),
      siloEpisode('series-tmdb-9202', 1, 1, {
        libraryId: '3',
        resolutions: ['2160p'],
      }),
    ];
    await scanner().run();
    assert.equal(
      (await media(9104, MediaType.MOVIE)).status,
      MediaStatus.AVAILABLE
    );
    // With no 4K Sonarr, a 4K episode counts as standard.
    const show = await media(9202, MediaType.TV);
    assert.equal(show.status, MediaStatus.AVAILABLE);
    assert.equal(show.status4k, MediaStatus.UNKNOWN);
  });

  it('counts 4K episodes apart while a 4K Sonarr exists', async () => {
    getSettings().sonarr = [sonarr4k];
    shows.set(9203, fakeShow(9203, 'Lantern Song', [season(1, 2)]));
    silo.items = [
      siloSeries('series-tmdb-9203', { tmdbId: 9203 }),
      siloEpisode('series-tmdb-9203', 1, 1, { resolutions: ['2160p'] }),
      siloEpisode('series-tmdb-9203', 1, 2, {
        resolutions: ['2160p', '720p'],
      }),
    ];
    await scanner().run();
    const show = await media(9203, MediaType.TV);
    const first = show.seasons.find((s) => s.seasonNumber === 1);
    assert.equal(first?.status4k, MediaStatus.AVAILABLE);
    assert.equal(first?.status, MediaStatus.PARTIALLY_AVAILABLE);
    assert.equal(show.siloMediaId4k, 'series-tmdb-9203');
  });

  it('changes nothing when Silo speaks another API major', async () => {
    silo.apiMajor = 3;
    silo.items = [siloMovie('movie-tmdb-9105', { tmdbId: 9105 })];
    await scanner().run();
    assert.equal(await getRepository(Media).countBy({ tmdbId: 9105 }), 0);
    assert.ok(
      !silo.calls.some((c) => c.path === '/admin/catalog/items'),
      'no listing asked for'
    );
  });
});

describe('the Silo recently added scan', () => {
  it('reads only what was added since the last scan, and adds the new season', async () => {
    shows.set(
      9301,
      fakeShow(9301, 'Static Garden', [season(1, 1), season(2, 1)])
    );
    silo.items = [
      siloSeries('series-tmdb-9301', { tmdbId: 9301 }),
      siloEpisode('series-tmdb-9301', 1, 1),
    ];
    await scanner().run();
    assert.equal(
      (await media(9301, MediaType.TV)).status,
      MediaStatus.PARTIALLY_AVAILABLE
    );

    silo.calls = [];
    silo.items.push(
      siloEpisode('series-tmdb-9301', 2, 1, {
        addedAt: new Date().toISOString(),
      })
    );
    await scanner(true).run();

    const listings = silo.calls.filter(
      (c) => c.path === '/admin/catalog/items' && c.query.type
    );
    assert.ok(listings.length > 0);
    assert.ok(listings.every((c) => c.query.added_after));
    const show = await media(9301, MediaType.TV);
    assert.equal(show.status, MediaStatus.AVAILABLE);
    assert.equal(
      show.seasons.find((s) => s.seasonNumber === 1)?.status,
      MediaStatus.AVAILABLE,
      'season 1 kept'
    );
  });
});

describe('Silo availability', () => {
  it('marks what Silo no longer has as deleted, season by season', async () => {
    shows.set(
      9401,
      fakeShow(9401, 'Static Garden', [season(1, 1), season(2, 1)])
    );
    silo.items = [
      siloMovie('movie-tmdb-9402', { tmdbId: 9402 }),
      siloSeries('series-tmdb-9401', { tmdbId: 9401 }),
      siloEpisode('series-tmdb-9401', 1, 1),
      siloEpisode('series-tmdb-9401', 2, 1),
    ];
    await scanner().run();
    assert.equal(
      (await media(9401, MediaType.TV)).status,
      MediaStatus.AVAILABLE
    );

    // The film and season 2 are gone from Silo.
    silo.items = silo.items.filter(
      (item) =>
        item.content_id !== 'movie-tmdb-9402' &&
        item.content_id !== 'series-tmdb-9401-2-1'
    );
    Object.defineProperty(availabilitySync.tmdb, 'getTvShowForScan', {
      value: async ({ tvId }: { tvId: number }) => shows.get(tvId),
      configurable: true,
    });
    await availabilitySync.run();

    const movie = await media(9402, MediaType.MOVIE);
    assert.equal(movie.status, MediaStatus.DELETED);
    const show = await media(9401, MediaType.TV);
    assert.equal(
      show.seasons.find((s) => s.seasonNumber === 1)?.status,
      MediaStatus.AVAILABLE
    );
    assert.equal(
      show.seasons.find((s) => s.seasonNumber === 2)?.status,
      MediaStatus.DELETED
    );
    assert.equal(
      await getRepository(SiloEpisode).countBy({
        contentId: 'series-tmdb-9401-2-1',
      }),
      0,
      'the gone episode is forgotten'
    );
  });

  it('changes nothing while Silo is down', async () => {
    silo.items = [siloMovie('movie-tmdb-9403', { tmdbId: 9403 })];
    await scanner().run();
    silo.down = true;
    await availabilitySync.run();
    assert.equal(
      (await media(9403, MediaType.MOVIE)).status,
      MediaStatus.AVAILABLE
    );
  });
});

describe('Silo episodes in database maintenance', () => {
  it('forgets episodes Silo no longer has, and all of them once disconnected', async () => {
    await getRepository(SiloEpisode).save([
      new SiloEpisode({
        contentId: 'series-x-1-1',
        seriesId: 'series-x',
        libraryIds: ['2'],
        season: 1,
        episode: 1,
      }),
      new SiloEpisode({
        contentId: 'series-x-1-2',
        seriesId: 'series-x',
        libraryIds: ['2'],
        season: 1,
        episode: 2,
      }),
    ]);
    silo.items = [siloEpisode('series-x', 1, 1)];
    let report = await runDbMaintenance();
    assert.equal(report?.removed.siloEpisodes, 1);
    assert.equal(report?.rows.siloEpisodes, 1);
    assert.equal(report?.rows.siloPlays, 0);

    // Kept while Silo can't be asked.
    silo.down = true;
    report = await runDbMaintenance();
    assert.equal(report?.removed.siloEpisodes, 0);

    getSettings().silo.connected = false;
    getSettings().main.mediaServerType = MediaServerType.PLEX;
    getSettings().plex.connected = true;
    report = await runDbMaintenance();
    assert.equal(report?.removed.siloEpisodes, 1);
    assert.equal(await getRepository(SiloEpisode).count(), 0);
  });
});
