import animeList from '@server/api/animelist';
import type {
  JellyfinLibraryItem,
  JellyfinLibraryItemExtended,
  JellyfinMediaSource,
} from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbTvDetails,
  TmdbTvSeasonResult,
} from '@server/api/themoviedb/interfaces';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import {
  embyFullScanner,
  embyRecentScanner,
  jellyfinFullScanner,
} from '@server/lib/scanners/jellyfin';
import type {
  Library,
  RadarrSettings,
  SonarrSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import { runWithMockTimers } from '@server/test/runWithMockTimers';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

// --- Mock animeList.sync to avoid filesystem/network I/O in tests ---
Object.defineProperty(animeList, 'sync', {
  value: async () => {},
  configurable: true,
  writable: true,
});

// --- Mock JellyfinAPI ---
let getLibraryContentsImpl: (
  id: string
) => Promise<JellyfinLibraryItem[]> = async () => [];
let getItemDataImpl: (
  id: string
) => Promise<JellyfinLibraryItemExtended | undefined> = async () => undefined;
let getSeasonsImpl: (
  seriesID: string
) => Promise<JellyfinLibraryItem[]> = async () => [];
let getEpisodesImpl: (
  seriesID: string,
  seasonID: string
) => Promise<JellyfinLibraryItem[]> = async () => [];

Object.defineProperty(JellyfinAPI.prototype, 'getLibraryContents', {
  get() {
    return async (id: string) => getLibraryContentsImpl(id);
  },
  set() {},
  configurable: true,
});

Object.defineProperty(JellyfinAPI.prototype, 'getItemData', {
  get() {
    return async (id: string) => getItemDataImpl(id);
  },
  set() {},
  configurable: true,
});

Object.defineProperty(JellyfinAPI.prototype, 'getSeasons', {
  get() {
    return async (seriesID: string) => getSeasonsImpl(seriesID);
  },
  set() {},
  configurable: true,
});

Object.defineProperty(JellyfinAPI.prototype, 'getEpisodes', {
  get() {
    return async (seriesID: string, seasonID: string) =>
      getEpisodesImpl(seriesID, seasonID);
  },
  set() {},
  configurable: true,
});

Object.defineProperty(JellyfinAPI.prototype, 'setUserId', {
  get() {
    return () => {};
  },
  set() {},
  configurable: true,
});

// --- Mock TheMovieDb ---
let getTvShowImpl: (args: {
  tvId: number;
  language?: string;
}) => Promise<TmdbTvDetails> = async () => fakeTmdbShow(1);

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async (args: { tvId: number; language?: string }) =>
      getTvShowImpl(args);
  },
  set() {},
  configurable: true,
});

Object.defineProperty(TheMovieDb.prototype, 'getTvShowForScan', {
  get() {
    return async (args: { tvId: number; language?: string }) =>
      getTvShowImpl(args);
  },
  set() {},
  configurable: true,
});

// both are assigned in the constructor, so the prototype stubs miss the
// instances the scanners built when they were first imported
for (const scanner of [jellyfinFullScanner, embyFullScanner]) {
  for (const method of ['getTvShow', 'getTvShowForScan'] as const) {
    Object.defineProperty(scanner.tmdb, method, {
      value: async (args: { tvId: number; language?: string }) =>
        getTvShowImpl(args),
      configurable: true,
    });
  }
}

setupTestDb();

// --- Helpers ---

function fakeTmdbShow(
  tmdbId: number,
  seasons: TmdbTvSeasonResult[] = [
    {
      id: 1,
      air_date: '2024-01-01',
      episode_count: 10,
      name: 'Season 1',
      overview: '',
      season_number: 1,
    },
  ]
): TmdbTvDetails {
  return {
    id: tmdbId,
    content_ratings: { results: [] },
    created_by: [],
    episode_run_time: [],
    first_air_date: '2024-01-01',
    genres: [],
    homepage: '',
    in_production: false,
    languages: ['en'],
    last_air_date: '2024-01-01',
    name: 'Test Show',
    networks: [],
    number_of_episodes: 10,
    number_of_seasons: seasons.length,
    origin_country: ['US'],
    original_language: 'en',
    original_name: 'Test Show',
    overview: '',
    popularity: 0,
    production_companies: [],
    production_countries: [],
    spoken_languages: [],
    seasons,
    status: 'Ended',
    type: 'Scripted',
    vote_average: 0,
    vote_count: 0,
    aggregate_credits: { cast: [] },
    credits: { crew: [] },
    external_ids: {},
    keywords: { results: [] },
    videos: { results: [] },
  };
}

function fakeJellyfinSeriesItem(id: string): JellyfinLibraryItem {
  return {
    Name: 'Test Show',
    Id: id,
    Type: 'Series',
    HasSubtitles: false,
    LocationType: 'FileSystem',
    MediaType: 'Video',
  };
}

function fakeJellyfinShowMetadata(
  id: string,
  tmdbId: string
): JellyfinLibraryItemExtended {
  return {
    Name: 'Test Show',
    Id: id,
    Type: 'Series',
    HasSubtitles: false,
    LocationType: 'FileSystem',
    MediaType: 'Video',
    ProviderIds: { Tmdb: tmdbId },
  };
}

function fakeJellyfinSeason(
  seasonNumber: number,
  id: string
): JellyfinLibraryItem {
  return {
    Name: `Season ${seasonNumber}`,
    Id: id,
    IndexNumber: seasonNumber,
    Type: 'Season',
    HasSubtitles: false,
    LocationType: 'FileSystem',
    MediaType: 'Video',
  };
}

function fakeJellyfinEpisodes(count: number): JellyfinLibraryItem[] {
  return Array.from({ length: count }, (_, i) => ({
    Name: `Episode ${i + 1}`,
    Id: `ep-${i}`,
    IndexNumber: i + 1,
    Type: 'Episode' as const,
    HasSubtitles: false,
    LocationType: 'FileSystem' as const,
    MediaType: 'Video',
  }));
}

function configureJellyfinWithLibrary(
  libraries: Library[] = [
    { id: 'test-library-id', name: 'TV Shows', enabled: true, type: 'show' },
  ]
): void {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.JELLYFIN;
  settings.jellyfin = {
    ...settings.jellyfin,
    apiKey: 'test-api-key',
    libraries,
  };
}

describe('Jellyfin Scanner', () => {
  beforeEach(async () => {
    getLibraryContentsImpl = async () => [];
    getItemDataImpl = async () => undefined;
    getSeasonsImpl = async () => [];
    getEpisodesImpl = async () => [];
    getTvShowImpl = async () => fakeTmdbShow(1);

    const userRepository = getRepository(User);
    const existingAdmin = await userRepository.findOne({ where: { id: 1 } });
    if (!existingAdmin) {
      const admin = new User();
      admin.id = 1;
      admin.jellyfinUserId = 'admin-user-id';
      admin.jellyfinDeviceId = 'admin-device-id';
      admin.email = 'admin@test.com';
      admin.permissions = 2;
      admin.username = 'admin';
      await userRepository.save(admin);
    }
  });

  describe('in-flight request handling', () => {
    it('leaves an approved request alone when the show has no episodes yet', async () => {
      configureJellyfinWithLibrary();

      const mediaRepository = getRepository(Media);
      const requestRepository = getRepository(MediaRequest);
      const userRepository = getRepository(User);

      const requestedBy = await userRepository.findOneOrFail({
        where: { id: 1 },
      });

      const media = await mediaRepository.save(
        new Media({
          tmdbId: 6000,
          mediaType: MediaType.TV,
          status: MediaStatus.PROCESSING,
          jellyfinMediaId: 'jf-inflight-show-id',
          seasons: [
            new Season({
              seasonNumber: 1,
              status: MediaStatus.PROCESSING,
              status4k: MediaStatus.UNKNOWN,
            }),
          ],
        })
      );

      const settings = getSettings();
      settings.radarr = [];
      settings.sonarr = [];
      const request = await requestRepository.save(
        new MediaRequest({
          type: MediaType.TV,
          status: MediaRequestStatus.APPROVED,
          media,
          requestedBy,
          is4k: false,
        })
      );

      getTvShowImpl = async () => fakeTmdbShow(6000);

      getLibraryContentsImpl = async (id: string) =>
        id === 'test-library-id'
          ? [fakeJellyfinSeriesItem('jf-inflight-show-id')]
          : [];

      getItemDataImpl = async (id: string) =>
        id === 'jf-inflight-show-id'
          ? fakeJellyfinShowMetadata('jf-inflight-show-id', '6000')
          : undefined;

      getSeasonsImpl = async (seriesID: string) =>
        seriesID === 'jf-inflight-show-id'
          ? [fakeJellyfinSeason(1, 'jf-inflight-s1-id')]
          : [];

      getEpisodesImpl = async () => [];

      await runWithMockTimers(() => jellyfinFullScanner.run());

      const updatedRequest = await requestRepository.findOneOrFail({
        where: { id: request.id },
      });

      assert.strictEqual(
        updatedRequest.status,
        MediaRequestStatus.APPROVED,
        'A media server scan must not cancel a request Sonarr is still working on'
      );
    });
  });

  describe('empty TMDB season handling', () => {
    it('should mark show as available when all non-empty TMDB seasons are fully scanned and an empty placeholder season exists in the DB', async () => {
      configureJellyfinWithLibrary();

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 5000;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.PARTIALLY_AVAILABLE;
      media.jellyfinMediaId = 'jf-scanner-show-id';
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
        new Season({
          seasonNumber: 2,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
        new Season({
          seasonNumber: 3,
          status: MediaStatus.UNKNOWN,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];

      await mediaRepository.save(media);

      getTvShowImpl = async () =>
        fakeTmdbShow(5000, [
          {
            id: 1,
            air_date: '2024-01-01',
            episode_count: 10,
            name: 'Season 1',
            overview: '',
            season_number: 1,
          },
          {
            id: 2,
            air_date: '2024-01-01',
            episode_count: 10,
            name: 'Season 2',
            overview: '',
            season_number: 2,
          },
          {
            id: 3,
            air_date: '2024-01-01',
            episode_count: 0,
            name: 'Season 3',
            overview: '',
            season_number: 3,
          },
        ]);

      // Jellyfin: S1 and S2 are fully scanned; S3 has no files.
      getLibraryContentsImpl = async (id: string) => {
        if (id === 'test-library-id') {
          return [fakeJellyfinSeriesItem('jf-scanner-show-id')];
        }
        return [];
      };

      getItemDataImpl = async (id: string) => {
        if (id === 'jf-scanner-show-id') {
          return fakeJellyfinShowMetadata('jf-scanner-show-id', '5000');
        }
        return undefined;
      };

      getSeasonsImpl = async (seriesID: string) => {
        if (seriesID === 'jf-scanner-show-id') {
          return [
            fakeJellyfinSeason(1, 'jf-scanner-s1-id'),
            fakeJellyfinSeason(2, 'jf-scanner-s2-id'),
          ];
        }
        return [];
      };

      getEpisodesImpl = async (_seriesID: string, seasonID: string) => {
        if (seasonID === 'jf-scanner-s1-id') return fakeJellyfinEpisodes(10);
        if (seasonID === 'jf-scanner-s2-id') return fakeJellyfinEpisodes(10);
        return [];
      };

      await runWithMockTimers(() => jellyfinFullScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 5000 },
        relations: ['seasons'],
      });

      assert.strictEqual(
        updated.status,
        MediaStatus.AVAILABLE,
        'Show should be AVAILABLE when all non-empty TMDB seasons are fully scanned, ignoring empty placeholder seasons'
      );
    });

    it('should mark show as available when an orphan UNKNOWN season exists in the DB but not in TMDB', async () => {
      configureJellyfinWithLibrary();

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 5001;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.PARTIALLY_AVAILABLE;
      media.jellyfinMediaId = 'jf-orphan-show-id';
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
        // Not present in the TMDB season list below
        new Season({
          seasonNumber: 2,
          status: MediaStatus.UNKNOWN,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];

      await mediaRepository.save(media);

      getTvShowImpl = async () =>
        fakeTmdbShow(5001, [
          {
            id: 1,
            air_date: '2024-01-01',
            episode_count: 10,
            name: 'Season 1',
            overview: '',
            season_number: 1,
          },
        ]);

      getLibraryContentsImpl = async (id: string) => {
        if (id === 'test-library-id') {
          return [fakeJellyfinSeriesItem('jf-orphan-show-id')];
        }
        return [];
      };

      getItemDataImpl = async (id: string) => {
        if (id === 'jf-orphan-show-id') {
          return fakeJellyfinShowMetadata('jf-orphan-show-id', '5001');
        }
        return undefined;
      };

      getSeasonsImpl = async (seriesID: string) => {
        if (seriesID === 'jf-orphan-show-id') {
          return [fakeJellyfinSeason(1, 'jf-orphan-s1-id')];
        }
        return [];
      };

      getEpisodesImpl = async (_seriesID: string, seasonID: string) => {
        if (seasonID === 'jf-orphan-s1-id') return fakeJellyfinEpisodes(10);
        return [];
      };

      await runWithMockTimers(() => jellyfinFullScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 5001 },
        relations: ['seasons'],
      });

      assert.strictEqual(
        updated.status,
        MediaStatus.AVAILABLE,
        'Show should be AVAILABLE when the only DB season missing from TMDB is an UNKNOWN orphan placeholder'
      );
    });

    it('should keep show partially available when a season missing from TMDB was previously available', async () => {
      configureJellyfinWithLibrary();

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 5002;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.PARTIALLY_AVAILABLE;
      media.jellyfinMediaId = 'jf-deleted-show-id';
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
        new Season({
          seasonNumber: 2,
          status: MediaStatus.DELETED,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];

      await mediaRepository.save(media);

      getTvShowImpl = async () =>
        fakeTmdbShow(5002, [
          {
            id: 1,
            air_date: '2024-01-01',
            episode_count: 10,
            name: 'Season 1',
            overview: '',
            season_number: 1,
          },
        ]);

      getLibraryContentsImpl = async (id: string) => {
        if (id === 'test-library-id') {
          return [fakeJellyfinSeriesItem('jf-deleted-show-id')];
        }
        return [];
      };

      getItemDataImpl = async (id: string) => {
        if (id === 'jf-deleted-show-id') {
          return fakeJellyfinShowMetadata('jf-deleted-show-id', '5002');
        }
        return undefined;
      };

      getSeasonsImpl = async (seriesID: string) => {
        if (seriesID === 'jf-deleted-show-id') {
          return [fakeJellyfinSeason(1, 'jf-deleted-s1-id')];
        }
        return [];
      };

      getEpisodesImpl = async (_seriesID: string, seasonID: string) => {
        if (seasonID === 'jf-deleted-s1-id') return fakeJellyfinEpisodes(10);
        return [];
      };

      await runWithMockTimers(() => jellyfinFullScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 5002 },
        relations: ['seasons'],
      });

      assert.strictEqual(
        updated.status,
        MediaStatus.PARTIALLY_AVAILABLE,
        'Show should stay PARTIALLY_AVAILABLE when a DELETED season is missing from the metadata provider'
      );
    });
  });

  /*
   * Jellyfin and Emby list a file before they have read it. Until then it
   * has no media sources, or sources with no video stream, and so no
   * resolution: it counts as standard quality until the server knows.
   */
  describe('files the server has not read yet', () => {
    const movieLibrary: Library = {
      id: 'test-movie-library-id',
      name: 'Movies',
      enabled: true,
      type: 'movie',
    };

    const source = (widths: number[]): JellyfinMediaSource =>
      ({
        Protocol: 'File',
        Id: 'source',
        MediaStreams: [
          { Codec: 'aac', Type: 'Audio' },
          ...widths.map((Width) => ({ Codec: 'hevc', Type: 'Video', Width })),
        ],
      }) as unknown as JellyfinMediaSource;

    afterEach(() => {
      getSettings().radarr = [];
      getSettings().sonarr = [];
    });

    const scanMovie = async (
      tmdbId: number,
      MediaSources: JellyfinMediaSource[] | undefined
    ) => {
      configureJellyfinWithLibrary([movieLibrary]);
      getSettings().radarr = [{ id: 0, is4k: true } as RadarrSettings];
      const id = `jf-movie-${tmdbId}`;
      getLibraryContentsImpl = async (library: string) =>
        library === movieLibrary.id
          ? [
              {
                Name: 'Test Movie',
                Id: id,
                Type: 'Movie',
                HasSubtitles: false,
                LocationType: 'FileSystem',
                MediaType: 'Video',
              },
            ]
          : [];
      getItemDataImpl = async (item: string) =>
        item === id
          ? {
              Name: 'Test Movie',
              Id: id,
              Type: 'Movie',
              HasSubtitles: false,
              LocationType: 'FileSystem',
              MediaType: 'Video',
              ProviderIds: { Tmdb: String(tmdbId) },
              MediaSources,
            }
          : undefined;

      await runWithMockTimers(() => jellyfinFullScanner.run());

      return getRepository(Media).findOneByOrFail({ tmdbId });
    };

    it('marks a movie with no media sources available in standard quality', async () => {
      const media = await scanMovie(6300, undefined);

      assert.strictEqual(media.status, MediaStatus.AVAILABLE);
      assert.notStrictEqual(media.status4k, MediaStatus.AVAILABLE);
      assert.strictEqual(media.jellyfinMediaId, 'jf-movie-6300');
    });

    it('marks a movie whose source has no video stream yet available in standard quality', async () => {
      const media = await scanMovie(6301, [source([])]);

      assert.strictEqual(media.status, MediaStatus.AVAILABLE);
      assert.notStrictEqual(media.status4k, MediaStatus.AVAILABLE);
    });

    it('still places a read 4K movie in 4K only', async () => {
      const media = await scanMovie(6302, [source([3840])]);

      assert.notStrictEqual(media.status, MediaStatus.AVAILABLE);
      assert.strictEqual(media.status4k, MediaStatus.AVAILABLE);
    });

    it('counts episodes not read yet as standard quality', async () => {
      configureJellyfinWithLibrary();
      // With a 4K Sonarr, episodes are sorted by resolution.
      getSettings().sonarr = [{ id: 0, is4k: true } as SonarrSettings];
      getTvShowImpl = async () => fakeTmdbShow(6303);
      getLibraryContentsImpl = async (id: string) =>
        id === 'test-library-id' ? [fakeJellyfinSeriesItem('jf-unread')] : [];
      getItemDataImpl = async (id: string) =>
        id === 'jf-unread'
          ? fakeJellyfinShowMetadata('jf-unread', '6303')
          : undefined;
      getSeasonsImpl = async () => [fakeJellyfinSeason(1, 'jf-unread-s1')];
      // Ten episodes: four with no sources, three with a source not read
      // yet, three read as 4K.
      getEpisodesImpl = async () =>
        fakeJellyfinEpisodes(10).map((episode, i) => ({
          ...episode,
          MediaSources:
            i < 4 ? undefined : i < 7 ? [source([])] : [source([3840])],
        }));

      await runWithMockTimers(() => jellyfinFullScanner.run());

      const media = await getRepository(Media).findOneOrFail({
        where: { tmdbId: 6303 },
        relations: ['seasons'],
      });
      const season = media.seasons.find((s) => s.seasonNumber === 1);
      assert.strictEqual(season?.status, MediaStatus.PARTIALLY_AVAILABLE);
      assert.strictEqual(season?.status4k, MediaStatus.PARTIALLY_AVAILABLE);
      assert.strictEqual(media.status, MediaStatus.PARTIALLY_AVAILABLE);
    });
  });

  /*
   * A server still identifying a new library lists titles with no TMDB or
   * TVDB id yet. That is normal: the scan skips them quietly and says once,
   * at the end, how many and why. Every line names the server scanned.
   */
  describe('a server still identifying a new library', () => {
    type Line = {
      level: string;
      message: string;
      meta: Record<string, unknown>;
    };
    let lines: Line[] = [];
    let restore: (() => void)[] = [];

    beforeEach(() => {
      lines = [];
      restore = (['error', 'warn', 'info', 'debug'] as const).map((level) => {
        const capture = mock.method(
          logger,
          level,
          (message: string, meta: Record<string, unknown> = {}) => {
            lines.push({ level, message, meta });
            return logger;
          }
        );
        return () => capture.mock.restore();
      });
    });

    afterEach(() => {
      restore.forEach((undo) => undo());
      getSettings().main.mediaServerType = MediaServerType.JELLYFIN;
    });

    const movieLibrary: Library = {
      id: 'movies',
      name: 'Films',
      enabled: true,
      type: 'movie',
    };
    const showLibrary: Library = {
      id: 'shows',
      name: 'Series',
      enabled: true,
      type: 'show',
    };

    const listed = (
      Id: string,
      Name: string,
      Type: 'Movie' | 'Series',
      ProductionYear?: number
    ): JellyfinLibraryItem => ({
      Name,
      Id,
      Type,
      ProductionYear,
      HasSubtitles: false,
      LocationType: 'FileSystem',
      MediaType: 'Video',
    });

    /** Each library's items, and what the server says about each. */
    const serve = (
      items: Record<string, JellyfinLibraryItem[]>,
      providerIds: Record<string, JellyfinLibraryItemExtended['ProviderIds']>
    ) => {
      const all = Object.values(items).flat();
      getLibraryContentsImpl = async (id) => items[id] ?? [];
      getItemDataImpl = async (id) => {
        if (id === 'broken') throw new Error('database is locked');
        const item = all.find((i) => i.Id === id);
        return item && { ...item, ProviderIds: providerIds[id] ?? {} };
      };
    };

    const unidentifiedLibrary = () =>
      serve(
        {
          movies: [
            listed('3426', 'Brightfall', 'Movie', 2016),
            listed('3427', 'Home Movies', 'Movie'),
            listed('broken', 'Broken Film', 'Movie', 2001),
            listed('known', 'Known Film', 'Movie', 2020),
          ],
          shows: [
            listed('e44cc', 'Lumenward', 'Series', 2022),
            listed('lost', 'Lost Show', 'Series', 2004),
          ],
        },
        {
          known: { Tmdb: '6400' },
          // TMDB has no such series: looked up, not found, nothing stored.
          lost: { Tmdb: '777' },
        }
      );

    const everything = () =>
      lines.map((l) => `${l.message} ${JSON.stringify(l.meta)}`).join('\n');

    it("says Emby on an Emby server, and only once what it couldn't place yet", async () => {
      const settings = getSettings();
      settings.main.mediaServerType = MediaServerType.EMBY;
      settings.emby = {
        ...settings.emby,
        apiKey: 'test-api-key',
        libraries: [movieLibrary, showLibrary],
      };
      getTvShowImpl = async () => {
        throw new Error('[TMDB] 404');
      };
      unidentifiedLibrary();

      await runWithMockTimers(() => embyFullScanner.run());

      assert.doesNotMatch(everything(), /jellyfin/i);
      assert.ok(lines.every((l) => l.meta.label === 'Emby Sync'));

      // Titles Emby hasn't identified are not errors.
      const errors = lines.filter((l) => l.level === 'error');
      assert.equal(errors.length, 1, everything());
      assert.equal(
        errors[0].message,
        'Failed to process Emby item Broken Film (2001)'
      );
      assert.deepEqual(errors[0].meta, {
        label: 'Emby Sync',
        errorMessage: 'database is locked',
        item: { name: 'Broken Film', year: 2001, type: 'Movie', id: 'broken' },
      });

      const summaries = lines.filter((l) =>
        l.message.includes('identified by Emby yet')
      );
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].level, 'info');
      assert.equal(
        summaries[0].message,
        "Emby: 2 films and 1 series aren't identified by Emby yet, so they were skipped. They'll be picked up once Emby has identified them (in Emby: refresh the library's metadata, or use Identify on a title)."
      );
      assert.deepEqual([...(summaries[0].meta.examples as string[])].sort(), [
        'Brightfall (2016)',
        'Home Movies',
        'Lumenward (2022)',
      ]);

      // Each one skipped is a debug line naming it, never the whole item.
      const skipped = lines.filter((l) => l.message.startsWith('Skipped '));
      assert.equal(skipped.length, 3);
      assert.ok(skipped.every((l) => l.level === 'debug'));
      assert.deepEqual(
        skipped.find((l) => l.message.startsWith('Skipped Brightfall'))?.meta,
        {
          label: 'Emby Sync',
          item: { name: 'Brightfall', year: 2016, type: 'Movie', id: '3426' },
        }
      );
      for (const line of lines) {
        assert.ok(!('jellyfinitem' in line.meta));
        assert.doesNotMatch(
          JSON.stringify(line.meta),
          /ProviderIds|LocationType|HasSubtitles/
        );
      }

      // What is stored is as before: the identified film, nothing else.
      const media = await getRepository(Media).find();
      assert.deepEqual(
        media.map((m) => [m.tmdbId, m.embyMediaId]),
        [[6400, 'known']]
      );
    });

    it('says Jellyfin on a Jellyfin server', async () => {
      configureJellyfinWithLibrary([movieLibrary]);
      serve({ movies: [listed('3426', 'Brightfall', 'Movie', 2016)] }, {});

      await runWithMockTimers(() => jellyfinFullScanner.run());

      assert.doesNotMatch(everything(), /emby/i);
      assert.equal(lines.filter((l) => l.level === 'error').length, 0);
      const summary = lines.find((l) => l.message.startsWith('Jellyfin: '));
      assert.equal(
        summary?.message,
        "Jellyfin: 1 film isn't identified by Jellyfin yet, so it was skipped. It'll be picked up once Jellyfin has identified it (in Jellyfin: refresh the library's metadata, or use Identify on a title)."
      );
      assert.deepEqual(summary?.meta.examples, ['Brightfall (2016)']);
    });

    it('says nothing more when every title is identified', async () => {
      configureJellyfinWithLibrary([movieLibrary]);
      serve(
        { movies: [listed('known', 'Known Film', 'Movie', 2020)] },
        { known: { Tmdb: '6400' } }
      );

      await runWithMockTimers(() => jellyfinFullScanner.run());

      assert.equal(lines.filter((l) => l.level === 'error').length, 0);
      assert.ok(!lines.some((l) => /identified by/.test(l.message)));
    });

    it("names Emby when Emby can't be read", async () => {
      // A stand-in Emby that fails every request.
      const server = http.createServer((_req, res) => {
        res.statusCode = 500;
        res.end();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      try {
        const settings = getSettings();
        settings.main.mediaServerType = MediaServerType.EMBY;
        settings.emby = {
          ...settings.emby,
          ip: '127.0.0.1',
          port: (server.address() as AddressInfo).port,
          useSsl: false,
          urlBase: '',
          apiKey: 'test-api-key',
          libraries: [movieLibrary],
        };

        await embyRecentScanner.run();
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }

      assert.doesNotMatch(everything(), /jellyfin/i);
      const failed = lines.find((l) => l.meta.label === 'Emby API');
      assert.match(
        failed?.message ?? '',
        /^Something went wrong while getting library content from the Emby server/
      );
    });
  });
});
