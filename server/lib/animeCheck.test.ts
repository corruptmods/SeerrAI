import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import animeCheck, {
  inFolder,
  judgeMovie,
  judgeSeries,
} from '@server/lib/animeCheck';
import { Permission } from '@server/lib/permissions';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Anime Check: Sonarr series whose folder or series type, and Radarr movies
 * whose folder or profile, disagree with what Seerr says they are. It only
 * reports.
 */

setupTestDb();

const server = {
  activeDirectory: '/tv',
  activeAnimeDirectory: '/anime',
};

describe('judging one series', () => {
  it('knows a series is in a folder by the whole folder name', () => {
    assert.equal(inFolder('/anime/Yume no Tane', '/anime'), true);
    assert.equal(inFolder('/anime/Yume no Tane', '/anime/'), true);
    assert.equal(inFolder('/animeX/Show', '/anime'), false);
    assert.equal(inFolder('D:\\anime\\Show', 'D:/anime'), true);
  });

  it('flags anime typed or filed as standard, and the reverse', () => {
    assert.deepEqual(
      judgeSeries(
        { path: '/tv/Yume no Tane', seriesType: 'anime' },
        true,
        server
      ),
      { wrongType: false, wrongFolder: true, expectedFolder: '/anime' }
    );
    assert.deepEqual(
      judgeSeries(
        { path: '/anime/Yume no Tane', seriesType: 'standard' },
        true,
        server
      ),
      { wrongType: true, wrongFolder: false, expectedFolder: null }
    );
    assert.deepEqual(
      judgeSeries(
        { path: '/anime/Pipkin', seriesType: 'anime' },
        false,
        server
      ),
      { wrongType: true, wrongFolder: true, expectedFolder: '/tv' }
    );
    // A daily show is not anime and is fine as it is.
    assert.deepEqual(
      judgeSeries(
        { path: '/tv/The Nightly Desk', seriesType: 'daily' },
        false,
        server
      ),
      { wrongType: false, wrongFolder: false, expectedFolder: null }
    );
  });

  it('leaves folders alone until the anime folder is a folder of its own', () => {
    assert.deepEqual(
      judgeSeries({ path: '/tv/Yume no Tane', seriesType: 'anime' }, true, {
        activeDirectory: '/tv',
        activeAnimeDirectory: '/tv/',
      }),
      { wrongType: false, wrongFolder: false, expectedFolder: null }
    );
  });
});

const movieServer = {
  activeDirectory: '/movies',
  activeAnimeDirectory: '/anime-movies',
  activeProfileId: 6,
  activeProfileName: '1080p Efficient',
  activeAnimeProfileId: 9,
  activeAnimeProfileName: 'Anime 1080p',
};

describe('judging one movie', () => {
  it('flags anime filed or profiled as a movie, and the reverse', () => {
    assert.deepEqual(
      judgeMovie(
        { path: '/movies/Lantern Drift (2001)', qualityProfileId: 6 },
        true,
        movieServer
      ),
      {
        wrongFolder: true,
        expectedFolder: '/anime-movies',
        wrongProfile: true,
        expectedProfile: 'Anime 1080p',
      }
    );
    assert.deepEqual(
      judgeMovie(
        { path: '/anime-movies/Scorch (1995)', qualityProfileId: 9 },
        false,
        movieServer
      ),
      {
        wrongFolder: true,
        expectedFolder: '/movies',
        wrongProfile: true,
        expectedProfile: '1080p Efficient',
      }
    );
  });

  it('lets other movies sit on any profile but the anime one', () => {
    assert.deepEqual(
      judgeMovie(
        { path: '/movies/Zelvara (2021)', qualityProfileId: 7 },
        false,
        movieServer
      ),
      {
        wrongFolder: false,
        expectedFolder: null,
        wrongProfile: false,
        expectedProfile: null,
      }
    );
  });

  it('checks only what the server has an anime setting of its own for', () => {
    assert.deepEqual(
      judgeMovie(
        { path: '/movies/Lantern Drift (2001)', qualityProfileId: 6 },
        true,
        { ...movieServer, activeAnimeDirectory: undefined }
      ),
      {
        wrongFolder: false,
        expectedFolder: null,
        wrongProfile: true,
        expectedProfile: 'Anime 1080p',
      }
    );
    assert.deepEqual(
      judgeMovie(
        { path: '/movies/Lantern Drift (2001)', qualityProfileId: 6 },
        true,
        { ...movieServer, activeAnimeProfileId: 6 }
      ).wrongProfile,
      false
    );
  });
});

describe('the Anime Check job', () => {
  it('reports what disagrees, honouring a title set on its page or a type chosen for its request, and changes nothing', async (t) => {
    getSettings().sonarr = [
      {
        id: 0,
        name: 'Sonarr',
        hostname: 'localhost',
        port: 8989,
        apiKey: 'key',
        useSsl: false,
        baseUrl: '',
        activeProfileId: 1,
        activeDirectory: '/tv',
        activeAnimeDirectory: '/anime',
        is4k: false,
        isDefault: true,
        syncEnabled: true,
        preventSearch: false,
        enableSeasonFolders: true,
        tags: [],
        animeTags: [],
      } as unknown as SonarrSettings,
    ];

    const sonarrSeries = [
      // Japanese animation without the keyword, filed as TV.
      {
        id: 1,
        title: 'Yume no Tane',
        tmdbId: 314862,
        tvdbId: 532178,
        path: '/tv/Yume no Tane',
        seriesType: 'anime',
      },
      // Correct as it is.
      {
        id: 2,
        title: 'Minamo',
        tmdbId: 318954,
        tvdbId: 536127,
        path: '/anime/Minamo',
        seriesType: 'anime',
      },
      // Korean animation an admin chose to send as anime.
      {
        id: 3,
        title: 'Korean Show',
        tmdbId: 500,
        tvdbId: 5000,
        path: '/tv/Korean Show',
        seriesType: 'standard',
      },
      // No TMDB id in Sonarr, found by TVDB id; live action.
      {
        id: 4,
        title: 'Live Action',
        tvdbId: 6000,
        path: '/tv/Live Action',
        seriesType: 'standard',
      },
      // TMDB does not know it.
      {
        id: 5,
        title: 'Unknown',
        tvdbId: 7000,
        path: '/tv/Unknown',
        seriesType: 'standard',
      },
    ];
    t.mock.method(SonarrAPI.prototype, 'getSeries', async () => sonarrSeries);

    const shows: Record<number, unknown> = {
      314862: {
        id: 314862,
        genres: [{ id: 16 }],
        original_language: 'ja',
        keywords: { results: [] },
      },
      318954: {
        id: 318954,
        genres: [{ id: 16 }],
        original_language: 'ja',
        keywords: { results: [{ id: 210024 }] },
      },
      500: {
        id: 500,
        genres: [{ id: 16 }],
        original_language: 'ko',
        keywords: { results: [] },
      },
    };
    const byTvdb: Record<number, unknown> = {
      6000: {
        id: 600,
        genres: [{ id: 18 }],
        original_language: 'ja',
        keywords: { results: [] },
      },
    };
    // An instance property, so replaced the way the other tests do.
    Object.defineProperty(TheMovieDb.prototype, 'getTvShowForScan', {
      configurable: true,
      set() {},
      get() {
        return async ({ tvId }: { tvId: number }) => {
          if (!shows[tvId]) {
            throw new Error('not found');
          }
          return shows[tvId];
        };
      },
    });
    t.mock.method(
      TheMovieDb.prototype,
      'getShowByTvdbIdForScan',
      async ({ tvdbId }: { tvdbId: number }) => {
        if (!byTvdb[tvdbId]) {
          throw new Error('not found');
        }
        return byTvdb[tvdbId];
      }
    );
    // Nothing in Sonarr is changed.
    const writes = (
      [
        'addSeries',
        'searchSeries',
        'searchSeason',
        'setEpisodeMonitoring',
        'searchEpisodes',
        'monitorEpisodes',
      ] as const
    ).map((name) =>
      t.mock.method(SonarrAPI.prototype, name, async () => {
        throw new Error(`${name} must not be called`);
      })
    );

    const user = await getRepository(User).save(
      new User({
        email: 'anime@test.local',
        plexUsername: 'anime',
        permissions: Permission.ADMIN,
        avatar: '',
      })
    );
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 500,
        mediaType: MediaType.TV,
        status: MediaStatus.AVAILABLE,
      })
    );
    await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        requestedBy: user,
        type: MediaType.TV,
        status: MediaRequestStatus.COMPLETED,
        is4k: false,
        seriesType: 'anime',
      })
    );
    // Set as not anime on its page: its folder is right, its type is not.
    await getRepository(Media).save(
      new Media({
        tmdbId: 314862,
        mediaType: MediaType.TV,
        status: MediaStatus.AVAILABLE,
        animeSetting: false,
      })
    );

    await animeCheck.run();
    const report = await animeCheck.lastReport();
    assert.ok(report.finishedAt);
    const [result] = report.servers;
    assert.equal(result.seriesChecked, 4);
    assert.equal(result.unmatched, 1);
    assert.deepEqual(
      result.problems.map((p) => [
        p.title,
        p.wrongType,
        p.wrongFolder,
        p.expectedFolder,
        p.decidedBy,
      ]),
      [
        ['Korean Show', true, true, '/anime', 'request'],
        ['Yume no Tane', true, false, null, 'title'],
      ]
    );
    assert.equal(
      writes.reduce((calls, w) => calls + w.mock.callCount(), 0),
      0
    );
  });

  it('reports movies Radarr has wrong, and changes nothing', async (t) => {
    getSettings().sonarr = [];
    getSettings().radarr = [
      {
        id: 0,
        name: 'Radarr',
        hostname: 'localhost',
        port: 7878,
        apiKey: 'key',
        useSsl: false,
        baseUrl: '',
        is4k: false,
        isDefault: true,
        syncEnabled: true,
        preventSearch: false,
        minimumAvailability: 'released',
        tags: [],
        ...movieServer,
      } as unknown as RadarrSettings,
      // No anime settings of its own: nothing to check, and not read.
      {
        id: 1,
        name: 'Radarr 4K',
        activeDirectory: '/movies-4k',
        activeProfileId: 7,
        is4k: true,
        isDefault: true,
      } as unknown as RadarrSettings,
    ];

    const movies = [
      // Japanese animation without the keyword, filed as a movie.
      {
        id: 1,
        title: 'Lantern Drift',
        tmdbId: 129,
        path: '/movies/Lantern Drift (2001)',
        qualityProfileId: 6,
      },
      // Correct as it is.
      {
        id: 2,
        title: 'Our Tide.',
        tmdbId: 483619,
        path: '/anime-movies/Our Tide. (2016)',
        qualityProfileId: 9,
      },
      // An admin chose to send it as anime.
      {
        id: 3,
        title: 'The Amber Tortoise',
        tmdbId: 449258,
        path: '/movies/The Amber Tortoise (2016)',
        qualityProfileId: 6,
      },
      // TMDB does not know it.
      {
        id: 4,
        title: 'Unknown',
        tmdbId: 1,
        path: '/movies/Unknown',
        qualityProfileId: 6,
      },
    ];
    let reads = 0;
    Object.defineProperty(RadarrAPI.prototype, 'getMovies', {
      configurable: true,
      set() {},
      get() {
        return async () => {
          reads += 1;
          return movies;
        };
      },
    });
    const details: Record<number, unknown> = {
      129: {
        id: 129,
        genres: [{ id: 16 }],
        original_language: 'ja',
        keywords: { keywords: [] },
      },
      483619: {
        id: 483619,
        genres: [{ id: 16 }],
        original_language: 'ja',
        keywords: { keywords: [{ id: 210024 }] },
      },
      449258: {
        id: 449258,
        genres: [{ id: 16 }],
        original_language: 'xx',
        keywords: { keywords: [] },
      },
    };
    Object.defineProperty(TheMovieDb.prototype, 'getMovieForScan', {
      configurable: true,
      set() {},
      get() {
        return async ({ movieId }: { movieId: number }) => {
          if (!details[movieId]) {
            throw new Error('not found');
          }
          return details[movieId];
        };
      },
    });
    // Nothing in Radarr is changed.
    let writes = 0;
    for (const name of ['addMovie', 'removeMovie'] as const) {
      Object.defineProperty(RadarrAPI.prototype, name, {
        configurable: true,
        set() {},
        get() {
          return async () => {
            writes += 1;
          };
        },
      });
    }
    for (const name of ['searchMovie', 'searchMovies'] as const) {
      t.mock.method(RadarrAPI.prototype, name, async () => {
        writes += 1;
      });
    }

    const user = await getRepository(User).save(
      new User({
        email: 'anime-movies@test.local',
        plexUsername: 'anime-movies',
        permissions: Permission.ADMIN,
        avatar: '',
      })
    );
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 449258,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
      })
    );
    await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        requestedBy: user,
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        is4k: false,
        seriesType: 'anime',
      })
    );

    await animeCheck.run();
    const report = await animeCheck.lastReport();
    const [main, uhd] = report.movieServers ?? [];
    assert.equal(main.moviesChecked, 3);
    assert.equal(main.unmatched, 1);
    assert.deepEqual(
      main.problems.map((p) => [
        p.title,
        p.wrongFolder,
        p.wrongProfile,
        p.expectedFolder,
        p.decidedBy,
      ]),
      [
        ['Lantern Drift', true, true, '/anime-movies', 'detection'],
        ['The Amber Tortoise', true, true, '/anime-movies', 'request'],
      ]
    );
    assert.deepEqual(
      [uhd.foldersChecked, uhd.profilesChecked, uhd.moviesChecked],
      [false, false, 0]
    );
    assert.equal(reads, 1);
    assert.equal(writes, 0);
  });
});
