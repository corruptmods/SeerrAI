import animeList from '@server/api/animelist';
import type {
  PlexLibrary,
  PlexLibraryItem,
  PlexMetadata,
} from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
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
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { plexFullScanner } from '@server/lib/scanners/plex';
import type { Library, RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import { runWithMockTimers } from '@server/test/runWithMockTimers';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

Object.defineProperty(animeList, 'sync', {
  value: async () => {},
  configurable: true,
  writable: true,
});

let getLibrariesImpl: () => Promise<PlexLibrary[]> = async () => [];
let getLibraryContentsImpl: (
  id: string
) => Promise<{ totalSize: number; items: PlexLibraryItem[] }> = async () => ({
  totalSize: 0,
  items: [],
});
let getMetadataImpl: (
  key: string
) => Promise<PlexMetadata | undefined> = async () => undefined;
let getChildrenMetadataImpl: (
  key: string
) => Promise<PlexMetadata[]> = async () => [];

Object.defineProperty(PlexAPI.prototype, 'getLibraries', {
  get() {
    return async () => getLibrariesImpl();
  },
  set() {},
  configurable: true,
});

Object.defineProperty(PlexAPI.prototype, 'getLibraryContents', {
  get() {
    return async (id: string) => getLibraryContentsImpl(id);
  },
  set() {},
  configurable: true,
});

Object.defineProperty(PlexAPI.prototype, 'getMetadata', {
  get() {
    return async (key: string) => getMetadataImpl(key);
  },
  set() {},
  configurable: true,
});

Object.defineProperty(PlexAPI.prototype, 'getChildrenMetadata', {
  get() {
    return async (key: string) => getChildrenMetadataImpl(key);
  },
  set() {},
  configurable: true,
});

let getTvShowImpl: (args: {
  tvId: number;
}) => Promise<TmdbTvDetails> = async () => fakeTmdbShow(1);

for (const method of ['getTvShow', 'getTvShowForScan'] as const) {
  Object.defineProperty(TheMovieDb.prototype, method, {
    get() {
      return async (args: { tvId: number }) => getTvShowImpl(args);
    },
    set() {},
    configurable: true,
  });

  // plexFullScanner built its own TheMovieDb on import, before the stubs above.
  Object.defineProperty(plexFullScanner.tmdb, method, {
    value: async (args: { tvId: number }) => getTvShowImpl(args),
    configurable: true,
  });
}

mock.method(MediaRequest, 'sendNotification', async () => undefined);

setupTestDb();

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

function fakePlexShowItem(ratingKey: string): PlexLibraryItem {
  return {
    ratingKey,
    title: 'Test Show',
    guid: 'plex://show/test-show',
    addedAt: 1700000000,
    updatedAt: 1700000000,
    type: 'show',
    Media: [],
  };
}

function fakePlexShowMetadata(
  ratingKey: string,
  tmdbId: number,
  children: PlexMetadata[]
): PlexMetadata {
  return {
    ratingKey,
    title: 'Test Show',
    guid: 'plex://show/test-show',
    type: 'show',
    Guid: [{ id: `tmdb://${tmdbId}` }],
    Children: { size: 12, Metadata: children },
    index: 1,
    leafCount: 0,
    viewedLeafCount: 0,
    addedAt: 1700000000,
    updatedAt: 1700000000,
    Media: [],
  };
}

function fakePlexSeasonMetadata(
  seasonNumber: number,
  ratingKey: string
): PlexMetadata {
  return {
    ratingKey,
    title: `Season ${seasonNumber}`,
    guid: `plex://season/test-season-${seasonNumber}`,
    type: 'season',
    Guid: [],
    index: seasonNumber,
    leafCount: 0,
    viewedLeafCount: 0,
    addedAt: 1700000000,
    updatedAt: 1700000000,
    Media: [],
  };
}

function configurePlexWithLibrary(
  libraries: Library[] = [
    { id: 'test-library-id', name: 'TV Shows', enabled: true, type: 'show' },
  ]
): void {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.plex = {
    ...settings.plex,
    ip: '127.0.0.1',
    port: 32400,
    libraries,
  };
}

function fakePlexMovieItem(
  ratingKey: string,
  tmdbId: number,
  resolutions: string[]
): PlexLibraryItem {
  return {
    ratingKey,
    title: 'Test Movie',
    guid: 'plex://movie/test-movie',
    Guid: [{ id: `tmdb://${tmdbId}` }],
    addedAt: 1700000000,
    updatedAt: 1700000000,
    type: 'movie',
    Media: resolutions.map(
      (videoResolution) =>
        ({ videoResolution }) as PlexLibraryItem['Media'][number]
    ),
  };
}

const movieLibrary: Library = {
  id: 'test-movie-library-id',
  name: 'Movies',
  enabled: true,
  type: 'movie',
};

describe('Plex Scanner', () => {
  beforeEach(() => {
    getLibrariesImpl = async () => [
      {
        key: 'test-library-id',
        title: 'TV Shows',
        type: 'show',
        agent: 'tv.plex.agents.series',
      },
    ];
    getLibraryContentsImpl = async () => ({ totalSize: 0, items: [] });
    getMetadataImpl = async () => undefined;
    getChildrenMetadataImpl = async () => [];
    getTvShowImpl = async () => fakeTmdbShow(1);
  });

  describe('in-flight request handling', () => {
    it('leaves an approved request alone when the show has no episodes yet', async () => {
      configurePlexWithLibrary();

      const mediaRepository = getRepository(Media);
      const requestRepository = getRepository(MediaRequest);
      const userRepository = getRepository(User);

      const requestedBy = await userRepository.findOneOrFail({
        where: { id: 1 },
      });

      const media = await mediaRepository.save(
        new Media({
          tmdbId: 6100,
          mediaType: MediaType.TV,
          status: MediaStatus.PROCESSING,
          status4k: MediaStatus.UNKNOWN,
          ratingKey: 'plex-inflight-show-key',
          seasons: [
            new Season({
              seasonNumber: 1,
              status: MediaStatus.PROCESSING,
              status4k: MediaStatus.UNKNOWN,
            }),
          ],
        })
      );

      // sendToSonarr runs on insert and only bails when no server is configured,
      // so leftover settings from another test would reach TMDB and fail the request.
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
          seasons: [
            new SeasonRequest({
              seasonNumber: 1,
              status: MediaRequestStatus.APPROVED,
            }),
          ],
        })
      );

      getTvShowImpl = async () => fakeTmdbShow(6100);

      getLibraryContentsImpl = async (id: string) =>
        id === 'test-library-id'
          ? {
              totalSize: 1,
              items: [fakePlexShowItem('plex-inflight-show-key')],
            }
          : { totalSize: 0, items: [] };

      getMetadataImpl = async (key: string) =>
        key === 'plex-inflight-show-key'
          ? fakePlexShowMetadata('plex-inflight-show-key', 6100, [
              fakePlexSeasonMetadata(1, 'plex-inflight-s1-key'),
            ])
          : undefined;

      getChildrenMetadataImpl = async () => [];

      await runWithMockTimers(() => plexFullScanner.run());

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

  describe('movie versions', () => {
    beforeEach(() => {
      configurePlexWithLibrary([movieLibrary]);
      getLibrariesImpl = async () => [
        {
          key: movieLibrary.id,
          title: 'Movies',
          type: 'movie',
          agent: 'tv.plex.agents.movie',
        },
      ];
    });

    afterEach(() => {
      getSettings().radarr = [];
    });

    const scanMovie = async (tmdbId: number, resolutions: string[]) => {
      getLibraryContentsImpl = async (id: string) =>
        id === movieLibrary.id
          ? {
              totalSize: 1,
              items: [
                fakePlexMovieItem(`movie-${tmdbId}`, tmdbId, resolutions),
              ],
            }
          : { totalSize: 0, items: [] };

      await runWithMockTimers(() => plexFullScanner.run());

      return getRepository(Media).findOneOrFail({ where: { tmdbId } });
    };

    it('marks both qualities available when one item holds a 1080p and a 4K version', async () => {
      getSettings().radarr = [{ id: 0, is4k: true } as RadarrSettings];

      const media = await scanMovie(6200, ['1080', '4k']);

      assert.strictEqual(media.status, MediaStatus.AVAILABLE);
      assert.strictEqual(media.status4k, MediaStatus.AVAILABLE);
      assert.strictEqual(media.ratingKey, 'movie-6200');
      assert.strictEqual(media.ratingKey4k, 'movie-6200');
    });

    it('marks only 4K available for a 4K-only item', async () => {
      getSettings().radarr = [{ id: 0, is4k: true } as RadarrSettings];

      const media = await scanMovie(6201, ['4k']);

      assert.notStrictEqual(media.status, MediaStatus.AVAILABLE);
      assert.strictEqual(media.status4k, MediaStatus.AVAILABLE);
    });

    it('counts a 4K version as standard when there is no 4K Radarr', async () => {
      const media = await scanMovie(6202, ['4k']);

      assert.strictEqual(media.status, MediaStatus.AVAILABLE);
      assert.notStrictEqual(media.status4k, MediaStatus.AVAILABLE);
    });
  });

  /*
   * Plex lists a file before its agent has matched it. Such a title is
   * skipped quietly and counted; the scan says once, at the end, how many.
   */
  describe('titles Plex has not matched yet', () => {
    type Line = {
      level: string;
      message: string;
      meta: Record<string, unknown>;
    };
    let lines: Line[] = [];
    let restore: (() => void)[] = [];
    const resolveImdb = Object.getOwnPropertyDescriptor(
      plexFullScanner.tmdb,
      'resolveImdbIdForScan'
    );

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
      configurePlexWithLibrary([movieLibrary]);
      getLibrariesImpl = async () => [
        {
          key: movieLibrary.id,
          title: 'Movies',
          type: 'movie',
          agent: 'tv.plex.agents.movie',
        },
      ];
      Object.defineProperty(plexFullScanner.tmdb, 'resolveImdbIdForScan', {
        value: async () => {
          throw new Error('[TMDB] Failed to find media using external IMDb ID');
        },
        configurable: true,
      });
    });

    afterEach(() => {
      restore.forEach((undo) => undo());
      if (resolveImdb) {
        Object.defineProperty(
          plexFullScanner.tmdb,
          'resolveImdbIdForScan',
          resolveImdb
        );
      }
    });

    const item = (
      ratingKey: string,
      title: string,
      guid: string,
      year?: number
    ): PlexLibraryItem => ({
      ratingKey,
      title,
      year,
      guid,
      addedAt: 1700000000,
      updatedAt: 1700000000,
      type: 'movie',
      Media: [],
    });

    it('skips them without an error each, and says how many once', async () => {
      getLibraryContentsImpl = async () => ({
        totalSize: 4,
        items: [
          // Never matched (the "none" agent): no id at all.
          item('901', 'Home Video', 'local://901', 2020),
          // The new agent before it has matched: no Guid list yet.
          item('902', 'Brine', 'plex://movie/5d776'),
          // Matched, but TMDB can't be asked: a real failure.
          item('903', 'Gone Film', 'imdb://tt0000003', 1999),
          { ...fakePlexMovieItem('904', 6210, ['1080']), title: 'Fine' },
        ],
      });
      getMetadataImpl = async (key) =>
        key === '902'
          ? ({ ...item('902', 'Brine', 'plex://movie/5d776') } as never)
          : undefined;

      await runWithMockTimers(() => plexFullScanner.run());

      const all = lines
        .map((l) => `${l.message} ${JSON.stringify(l.meta)}`)
        .join('\n');
      const errors = lines.filter((l) => l.level === 'error');
      assert.equal(errors.length, 1, all);
      assert.equal(errors[0].message, 'Failed to process Plex media');
      assert.deepEqual(errors[0].meta, {
        label: 'Plex Scan',
        errorMessage: '[TMDB] Failed to find media using external IMDb ID',
        item: { name: 'Gone Film', year: 1999, type: 'movie', id: '903' },
      });

      const summaries = lines.filter((l) => /matched by Plex/.test(l.message));
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].level, 'info');
      assert.equal(
        summaries[0].message,
        "Plex: 2 films aren't matched by Plex yet, so they were skipped. They'll be picked up once Plex has matched them (in Plex: refresh the library's metadata, or use Match on a title)."
      );
      assert.deepEqual([...(summaries[0].meta.examples as string[])].sort(), [
        'Brine',
        'Home Video (2020)',
      ]);
      const skipped = lines.filter((l) => l.message.startsWith('Skipped '));
      assert.ok(skipped.every((l) => l.level === 'debug'));
      assert.deepEqual(
        skipped
          .map((l) => l.meta.item)
          .sort((a, b) =>
            String((a as { id: string }).id).localeCompare(
              String((b as { id: string }).id)
            )
          ),
        [
          { name: 'Home Video', year: 2020, type: 'movie', id: '901' },
          { name: 'Brine', type: 'movie', id: '902' },
        ]
      );

      // What is stored is as before.
      const media = await getRepository(Media).find();
      assert.deepEqual(
        media.map((m) => m.tmdbId),
        [6210]
      );
    });
  });
});
