import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type {
  JellyfinLibraryItem,
  JellyfinLibraryItemExtended,
} from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import type { PlexMetadata } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import type { SonarrSeason, SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbTvDetails,
  TmdbTvSeasonResult,
} from '@server/api/themoviedb/interfaces';
import { ApiErrorCode } from '@server/constants/error';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import { MEDIA_SERVER_KINDS, typeOfKind } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import availabilitySync from '@server/lib/availabilitySync';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { ApiError } from '@server/types/error';

// --- Mock JellyfinAPI ---
let getSystemInfoImpl: (
  kind: JellyfinAPI['kind']
) => Promise<Record<string, unknown>> = async () => ({
  ServerName: 'Test',
});
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

Object.defineProperty(JellyfinAPI.prototype, 'getSystemInfo', {
  get() {
    const kind = (this as JellyfinAPI).kind;
    return async () => getSystemInfoImpl(kind);
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

// --- Mock PlexAPI ---
let getMetadataImpl: (
  key: string,
  options?: { includeChildren?: boolean }
) => Promise<PlexMetadata> = async () => {
  throw new Error('404');
};
let getChildrenMetadataImpl: (
  key: string
) => Promise<PlexMetadata[]> = async () => [];

Object.defineProperty(PlexAPI.prototype, 'getMetadata', {
  get() {
    return async (key: string, options?: { includeChildren?: boolean }) =>
      getMetadataImpl(key, options);
  },
  set() {},
  configurable: true,
});

let getStatusImpl: () => Promise<unknown> = async () => ({});

Object.defineProperty(PlexAPI.prototype, 'getStatus', {
  get() {
    return async () => getStatusImpl();
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

// --- Mock SonarrAPI ---
let getSeriesByIdImpl: (id: number) => Promise<SonarrSeries> = async () => {
  throw new Error('404');
};

Object.defineProperty(SonarrAPI.prototype, 'getSeriesById', {
  get() {
    return async (id: number) => getSeriesByIdImpl(id);
  },
  set() {},
  configurable: true,
});

// --- Mock RadarrAPI ---
let getMovieImpl: (id: number) => Promise<RadarrMovie> = async () => {
  throw new Error('404');
};

Object.defineProperty(RadarrAPI.prototype, 'getMovie', {
  get() {
    return async ({ id }: { id: number }) => getMovieImpl(id);
  },
  set() {},
  configurable: true,
});

// --- Mock TheMovieDb ---
let getTvShowImpl: (args: {
  tvId: number;
  language?: string;
}) => Promise<TmdbTvDetails> = async () => fakeTmdbShow(1);
let getShowByTvdbIdImpl: (args: {
  tvdbId: number;
  language?: string;
}) => Promise<TmdbTvDetails> = async () => fakeTmdbShow(1);

Object.defineProperty(TheMovieDb.prototype, 'getTvShowForScan', {
  get() {
    return async (args: { tvId: number; language?: string }) =>
      getTvShowImpl(args);
  },
  set() {},
  configurable: true,
});

Object.defineProperty(TheMovieDb.prototype, 'getShowByTvdbIdForScan', {
  get() {
    return async (args: { tvdbId: number; language?: string }) =>
      getShowByTvdbIdImpl(args);
  },
  set() {},
  configurable: true,
});

// getTvShowForScan is assigned in the constructor, so the prototype stub misses
// the instance availabilitySync built when it was first imported
Object.defineProperty(availabilitySync.tmdb, 'getTvShowForScan', {
  value: async (args: { tvId: number; language?: string }) =>
    getTvShowImpl(args),
  configurable: true,
});

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

setupTestDb();

function configureSonarr(overrides: Partial<SonarrSettings>[] = [{}]): void {
  const settings = getSettings();
  settings.sonarr = overrides.map((o, i) => ({
    id: i,
    name: `Sonarr ${i}`,
    hostname: 'localhost',
    port: 8989,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/tv',
    activeLanguageProfileId: 1,
    activeAnimeProfileId: undefined,
    activeAnimeDirectory: '',
    activeAnimeLanguageProfileId: undefined,
    animeTags: [],
    is4k: false,
    enableSeasonFolders: true,
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as SonarrSettings[];
  settings.radarr = [];
}

function configureRadarr(overrides: Partial<RadarrSettings>[] = [{}]): void {
  const settings = getSettings();
  settings.radarr = overrides.map((o, i) => ({
    id: i,
    name: `Radarr ${i}`,
    hostname: 'localhost',
    port: 7878,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeProfileName: 'Default',
    activeDirectory: '/movies',
    minimumAvailability: 'released',
    tags: [],
    is4k: false,
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    tagRequests: false,
    overrideRule: [],
    externalUrl: '',
    ...o,
  })) as RadarrSettings[];
  settings.sonarr = [];
}

/**
 * Connects the servers given, the first as the primary one, and no others.
 */
function connectServers(...kinds: MediaServerKind[]): void {
  const settings = getSettings();
  settings.main.mediaServerType = typeOfKind(kinds[0]);
  for (const kind of MEDIA_SERVER_KINDS) {
    settings[kind].connected = kinds.includes(kind);
  }
  settings.jellyfin = { ...settings.jellyfin, apiKey: 'test-api-key' };
  settings.emby = { ...settings.emby, apiKey: 'test-emby-key' };
}

function configureJellyfin(): void {
  connectServers('jellyfin');
}

function configurePlex(): void {
  connectServers('plex');
}

// --- Jellyfin helpers ---
function fakeJellyfinSeason(
  seasonNumber: number,
  id?: string
): JellyfinLibraryItem {
  return {
    Name: `Season ${seasonNumber}`,
    Id: id ?? `jellyfin-season-${seasonNumber}-id`,
    IndexNumber: seasonNumber,
    Type: 'Season' as const,
    HasSubtitles: false,
    LocationType: 'FileSystem' as const,
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

function fakeJellyfinShow(
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

// --- Plex helpers ---
function fakePlexSeason(seasonNumber: number, ratingKey: string): PlexMetadata {
  return {
    ratingKey,
    guid: `plex://season/${ratingKey}`,
    type: 'season',
    title: `Season ${seasonNumber}`,
    Guid: [],
    index: seasonNumber,
    leafCount: 0,
    viewedLeafCount: 0,
    addedAt: 0,
    updatedAt: 0,
    Media: [],
  };
}

function fakePlexEpisodes(count: number): PlexMetadata[] {
  return Array.from({ length: count }, (_, i) => ({
    ratingKey: `ep-${i}`,
    guid: `plex://episode/ep-${i}`,
    type: 'movie' as const,
    title: `Episode ${i + 1}`,
    Guid: [],
    index: i + 1,
    leafCount: 0,
    viewedLeafCount: 0,
    addedAt: 0,
    updatedAt: 0,
    Media: [
      {
        id: i,
        duration: 2400,
        bitrate: 4000,
        width: 1920,
        height: 1080,
        aspectRatio: 1.78,
        audioChannels: 2,
        audioCodec: 'aac',
        videoCodec: 'h264',
        videoResolution: '1080',
        container: 'mkv',
        videoFrameRate: '24p',
        videoProfile: 'high',
      },
    ],
  }));
}

function fakePlexShow(ratingKey: string): PlexMetadata {
  return {
    ratingKey,
    guid: `plex://show/${ratingKey}`,
    type: 'show',
    title: 'Test Show',
    Guid: [],
    index: 1,
    leafCount: 0,
    viewedLeafCount: 0,
    addedAt: 0,
    updatedAt: 0,
    Media: [],
  };
}

// --- Sonarr helpers ---
function fakeSonarrSeasons(
  totalSeasons: number,
  seasonsWithFiles: Record<number, number>
): SonarrSeason[] {
  return Array.from({ length: totalSeasons }, (_, i) => ({
    seasonNumber: i + 1,
    monitored: true,
    statistics: {
      episodeFileCount: seasonsWithFiles[i + 1] ?? 0,
      totalEpisodeCount: 10,
      episodeCount: 10,
      percentOfEpisodes: seasonsWithFiles[i + 1] ? 100 : 0,
      sizeOnDisk: seasonsWithFiles[i + 1] ? 7516192768 : 0,
      previousAiring: undefined,
    },
  }));
}

describe('AvailabilitySync', () => {
  beforeEach(async () => {
    getSystemInfoImpl = async () => ({ ServerName: 'Test' });
    getItemDataImpl = async () => undefined;
    getSeasonsImpl = async () => [];
    getEpisodesImpl = async () => [];
    getMetadataImpl = async () => {
      throw new Error('404');
    };
    getChildrenMetadataImpl = async () => [];
    getStatusImpl = async () => ({});
    getSeriesByIdImpl = async () => {
      throw new Error('404');
    };
    getMovieImpl = async () => {
      throw new Error('404');
    };
    getTvShowImpl = async ({ tvId }) =>
      fakeTmdbShow(
        tvId,
        Array.from({ length: 4 }, (_, i) => ({
          id: i + 1,
          air_date: '2024-01-01',
          episode_count: 10,
          name: `Season ${i + 1}`,
          overview: '',
          season_number: i + 1,
        }))
      );
    getShowByTvdbIdImpl = async ({ tvdbId }) =>
      fakeTmdbShow(
        tvdbId,
        Array.from({ length: 4 }, (_, i) => ({
          id: i + 1,
          air_date: '2024-01-01',
          episode_count: 10,
          name: `Season ${i + 1}`,
          overview: '',
          season_number: i + 1,
        }))
      );

    const userRepository = getRepository(User);
    const existingAdmin = await userRepository.findOne({ where: { id: 1 } });
    if (!existingAdmin) {
      const admin = new User();
      admin.id = 1;
      admin.plexToken = 'test-plex-token';
      admin.jellyfinUserId = 'admin-user-id';
      admin.jellyfinDeviceId = 'admin-device-id';
      admin.email = 'admin@test.com';
      admin.permissions = 2;
      admin.username = 'admin';
      await userRepository.save(admin);
    }
  });

  describe('TV season availability - Jellyfin', () => {
    it('should mark deleted seasons as DELETED when only some seasons exist in Jellyfin and Sonarr', async () => {
      configureJellyfin();
      configureSonarr([{ syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1408;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.jellyfinMediaId = 'jellyfin-house-id';
      media.externalServiceId = 100;
      media.seasons = [];

      for (let i = 1; i <= 8; i++) {
        media.seasons.push(
          new Season({
            seasonNumber: i,
            status: MediaStatus.AVAILABLE,
            status4k: MediaStatus.UNKNOWN,
          })
        );
      }

      await mediaRepository.save(media);

      getItemDataImpl = async (id: string) => {
        if (id === 'jellyfin-house-id') {
          return fakeJellyfinShow('jellyfin-house-id', '1408');
        }
        return undefined;
      };

      getSeasonsImpl = async (seriesID: string) => {
        if (seriesID === 'jellyfin-house-id') {
          return [fakeJellyfinSeason(6)];
        }
        return [];
      };

      getEpisodesImpl = async (_seriesID: string, seasonID: string) => {
        if (seasonID === 'jellyfin-season-6-id') {
          return fakeJellyfinEpisodes(10);
        }
        return [];
      };

      getSeriesByIdImpl = async (id: number) => {
        if (id === 100) {
          return {
            tvdbId: 73255,
            id: 100,
            title: 'House',
            titleSlug: 'house',
            monitored: true,
            statistics: {
              episodeFileCount: 21,
              totalEpisodeCount: 10,
              episodeCount: 10,
              percentOfEpisodes: 100,
              sizeOnDisk: 0,
              seasonCount: 8,
            },
            seasons: fakeSonarrSeasons(8, { 6: 10 }),
          } as unknown as SonarrSeries;
        }
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1408 },
        relations: ['seasons'],
      });

      const s6 = updated.seasons.find((s) => s.seasonNumber === 6);
      assert.strictEqual(
        s6?.status,
        MediaStatus.AVAILABLE,
        'Season 6 should remain AVAILABLE'
      );

      for (const season of updated.seasons) {
        if (season.seasonNumber !== 6) {
          assert.strictEqual(
            season.status,
            MediaStatus.DELETED,
            `Season ${season.seasonNumber} should be DELETED but was ${season.status}`
          );
        }
      }

      assert.strictEqual(
        updated.status,
        MediaStatus.PARTIALLY_AVAILABLE,
        'Show should be PARTIALLY_AVAILABLE after season removal'
      );
    });

    it('should still mark deleted seasons when externalServiceId is null (no Sonarr link)', async () => {
      configureJellyfin();
      configureSonarr([{ syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1409;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.jellyfinMediaId = 'jellyfin-house2-id';
      media.externalServiceId = undefined as unknown as number;
      media.seasons = [];

      for (let i = 1; i <= 8; i++) {
        media.seasons.push(
          new Season({
            seasonNumber: i,
            status: MediaStatus.AVAILABLE,
            status4k: MediaStatus.UNKNOWN,
          })
        );
      }

      await mediaRepository.save(media);

      getItemDataImpl = async (id: string) => {
        if (id === 'jellyfin-house2-id') {
          return fakeJellyfinShow('jellyfin-house2-id', '1409');
        }
        return undefined;
      };

      getSeasonsImpl = async (seriesID: string) => {
        if (seriesID === 'jellyfin-house2-id') {
          return [fakeJellyfinSeason(6, 'jellyfin-house2-s6-id')];
        }
        return [];
      };

      getEpisodesImpl = async (_seriesID: string, seasonID: string) => {
        if (seasonID === 'jellyfin-house2-s6-id') {
          return fakeJellyfinEpisodes(21);
        }
        return [];
      };

      getSeriesByIdImpl = async () => {
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1409 },
        relations: ['seasons'],
      });

      const s6 = updated.seasons.find((s) => s.seasonNumber === 6);
      assert.strictEqual(
        s6?.status,
        MediaStatus.AVAILABLE,
        'Season 6 should remain AVAILABLE'
      );

      for (const season of updated.seasons) {
        if (season.seasonNumber !== 6) {
          assert.strictEqual(
            season.status,
            MediaStatus.DELETED,
            `Season ${season.seasonNumber} should be DELETED but was ${season.status}`
          );
        }
      }

      assert.strictEqual(
        updated.status,
        MediaStatus.PARTIALLY_AVAILABLE,
        'Show should be PARTIALLY_AVAILABLE after season removal'
      );
    });

    it('should mark deleted seasons even when Jellyfin returns empty season metadata entries (real-world behavior)', async () => {
      configureJellyfin();
      configureSonarr([{ syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1410;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.jellyfinMediaId = 'jellyfin-house3-id';
      media.externalServiceId = 101;
      media.seasons = [];

      for (let i = 1; i <= 8; i++) {
        media.seasons.push(
          new Season({
            seasonNumber: i,
            status: MediaStatus.AVAILABLE,
            status4k: MediaStatus.UNKNOWN,
          })
        );
      }

      await mediaRepository.save(media);

      getItemDataImpl = async (id: string) => {
        if (id === 'jellyfin-house3-id') {
          return fakeJellyfinShow('jellyfin-house3-id', '1410');
        }
        return undefined;
      };

      // MOCK REAL BEHAVIOR: Jellyfin returns ALL 8 season metadata entries
      // even though only season 6 has actual episode files.
      getSeasonsImpl = async (seriesID: string) => {
        if (seriesID === 'jellyfin-house3-id') {
          return Array.from({ length: 8 }, (_, i) =>
            fakeJellyfinSeason(i + 1, `jellyfin-house3-s${i + 1}-id`)
          );
        }
        return [];
      };

      // Only season 6 has actual episodes
      getEpisodesImpl = async (_seriesID: string, seasonID: string) => {
        if (seasonID === 'jellyfin-house3-s6-id') {
          return fakeJellyfinEpisodes(21);
        }
        return [];
      };

      getSeriesByIdImpl = async (id: number) => {
        if (id === 101) {
          return {
            tvdbId: 73255,
            id: 101,
            title: 'House',
            titleSlug: 'house',
            monitored: true,
            statistics: {
              episodeFileCount: 21,
              totalEpisodeCount: 177,
              episodeCount: 177,
              percentOfEpisodes: 11.86,
              sizeOnDisk: 0,
              seasonCount: 8,
            },
            seasons: fakeSonarrSeasons(8, { 6: 21 }),
          } as unknown as SonarrSeries;
        }
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1410 },
        relations: ['seasons'],
      });

      const s6 = updated.seasons.find((s) => s.seasonNumber === 6);
      assert.strictEqual(
        s6?.status,
        MediaStatus.AVAILABLE,
        'Season 6 should remain AVAILABLE'
      );

      for (const season of updated.seasons) {
        if (season.seasonNumber !== 6) {
          assert.strictEqual(
            season.status,
            MediaStatus.DELETED,
            `Season ${season.seasonNumber} should be DELETED but was ${season.status}`
          );
        }
      }

      assert.strictEqual(
        updated.status,
        MediaStatus.PARTIALLY_AVAILABLE,
        'Show should be PARTIALLY_AVAILABLE after season removal'
      );
    });

    it('should assume season exists when getEpisodes fails (safe fallback)', async () => {
      configureJellyfin();
      configureSonarr([{ syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1411;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.jellyfinMediaId = 'jellyfin-house4-id';
      media.externalServiceId = 102;
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];

      await mediaRepository.save(media);

      getItemDataImpl = async (id: string) => {
        if (id === 'jellyfin-house4-id') {
          return fakeJellyfinShow('jellyfin-house4-id', '1411');
        }
        return undefined;
      };

      getSeasonsImpl = async (seriesID: string) => {
        if (seriesID === 'jellyfin-house4-id') {
          return [fakeJellyfinSeason(1, 'jellyfin-house4-s1-id')];
        }
        return [];
      };

      getEpisodesImpl = async () => {
        throw new Error('Connection refused');
      };

      getSeriesByIdImpl = async (id: number) => {
        if (id === 102) {
          return {
            tvdbId: 99999,
            id: 102,
            title: 'House 4',
            titleSlug: 'house-4',
            monitored: true,
            statistics: {
              episodeFileCount: 10,
              totalEpisodeCount: 10,
              episodeCount: 10,
              percentOfEpisodes: 100,
              sizeOnDisk: 0,
              seasonCount: 1,
            },
            seasons: fakeSonarrSeasons(1, { 1: 10 }),
          } as unknown as SonarrSeries;
        }
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1411 },
        relations: ['seasons'],
      });

      assert.strictEqual(
        updated.seasons[0].status,
        MediaStatus.AVAILABLE,
        'Season should remain AVAILABLE when getEpisodes fails'
      );
      assert.strictEqual(
        updated.status,
        MediaStatus.AVAILABLE,
        'Show should remain AVAILABLE when getEpisodes fails'
      );
    });

    it('should mark show as PARTIALLY_AVAILABLE when some seasons are available and some are unknown', async () => {
      configureJellyfin();
      configureSonarr([{ syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1412;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.jellyfinMediaId = 'jellyfin-partial-id';
      media.externalServiceId = 103;
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
        new Season({
          seasonNumber: 4,
          status: MediaStatus.UNKNOWN,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];

      await mediaRepository.save(media);

      getItemDataImpl = async (id: string) => {
        if (id === 'jellyfin-partial-id') {
          return fakeJellyfinShow('jellyfin-partial-id', '1412');
        }
        return undefined;
      };

      getSeasonsImpl = async (seriesID: string) => {
        if (seriesID === 'jellyfin-partial-id') {
          return [
            fakeJellyfinSeason(1, 'jellyfin-partial-s1-id'),
            fakeJellyfinSeason(2, 'jellyfin-partial-s2-id'),
          ];
        }
        return [];
      };

      getEpisodesImpl = async (_seriesID: string, seasonID: string) => {
        if (seasonID === 'jellyfin-partial-s1-id') {
          return fakeJellyfinEpisodes(10);
        }
        if (seasonID === 'jellyfin-partial-s2-id') {
          return fakeJellyfinEpisodes(10);
        }
        return [];
      };

      getSeriesByIdImpl = async (id: number) => {
        if (id === 103) {
          return {
            tvdbId: 99997,
            id: 103,
            title: 'Partial Show',
            titleSlug: 'partial-show',
            monitored: true,
            statistics: {
              episodeFileCount: 20,
              totalEpisodeCount: 40,
              episodeCount: 40,
              percentOfEpisodes: 50,
              sizeOnDisk: 0,
              seasonCount: 4,
            },
            seasons: fakeSonarrSeasons(4, { 1: 10, 2: 10 }),
          } as unknown as SonarrSeries;
        }
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1412 },
        relations: ['seasons'],
      });

      assert.strictEqual(
        updated.status,
        MediaStatus.PARTIALLY_AVAILABLE,
        'Show should be PARTIALLY_AVAILABLE when some seasons are available and some are unknown'
      );
    });
  });

  describe('TV season availability - Plex', () => {
    it('should mark deleted seasons when Plex returns empty season metadata entries', async () => {
      configurePlex();
      configureSonarr([{ syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 2000;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.ratingKey = 'plex-house-rk';
      media.externalServiceId = 200;
      media.seasons = [];

      for (let i = 1; i <= 8; i++) {
        media.seasons.push(
          new Season({
            seasonNumber: i,
            status: MediaStatus.AVAILABLE,
            status4k: MediaStatus.UNKNOWN,
          })
        );
      }

      await mediaRepository.save(media);

      getMetadataImpl = async (key: string) => {
        if (key === 'plex-house-rk') {
          return fakePlexShow('plex-house-rk');
        }
        throw new Error('404');
      };

      // Plex returns ALL 8 season metadata entries,
      // but only season 6 has episode files
      getChildrenMetadataImpl = async (key: string) => {
        if (key === 'plex-house-rk') {
          return Array.from({ length: 8 }, (_, i) =>
            fakePlexSeason(i + 1, `plex-house-s${i + 1}-rk`)
          );
        }
        if (key === 'plex-house-s6-rk') {
          return fakePlexEpisodes(21);
        }
        return [];
      };

      // Sonarr: only season 6 has files
      getSeriesByIdImpl = async (id: number) => {
        if (id === 200) {
          return {
            tvdbId: 73255,
            id: 200,
            title: 'House',
            titleSlug: 'house',
            monitored: true,
            statistics: {
              episodeFileCount: 21,
              totalEpisodeCount: 177,
              episodeCount: 177,
              percentOfEpisodes: 11.86,
              sizeOnDisk: 0,
              seasonCount: 8,
            },
            seasons: fakeSonarrSeasons(8, { 6: 21 }),
          } as unknown as SonarrSeries;
        }
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 2000 },
        relations: ['seasons'],
      });

      const s6 = updated.seasons.find((s) => s.seasonNumber === 6);
      assert.strictEqual(
        s6?.status,
        MediaStatus.AVAILABLE,
        'Season 6 should remain AVAILABLE'
      );

      for (const season of updated.seasons) {
        if (season.seasonNumber !== 6) {
          assert.strictEqual(
            season.status,
            MediaStatus.DELETED,
            `Season ${season.seasonNumber} should be DELETED but was ${season.status}`
          );
        }
      }

      assert.strictEqual(
        updated.status,
        MediaStatus.PARTIALLY_AVAILABLE,
        'Show should be PARTIALLY_AVAILABLE after season removal'
      );
    });

    it('should mark a deleted show as DELETED when a second standard Sonarr instance has a colliding externalServiceId', async () => {
      configurePlex();
      configureSonarr([{ syncEnabled: true }, { syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 3000;
      media.tvdbId = 73255;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.ratingKey = 'gone-from-plex-rk';
      media.externalServiceId = 200;
      media.serviceId = 0;
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
      ];

      await mediaRepository.save(media);

      // Probed once per standard instance with the same id (200): origin 404s
      // (deleted); the other instance has a different series at 200.
      let sonarrCall = 0;
      getSeriesByIdImpl = async (id: number) => {
        if (id !== 200) {
          throw new Error('404');
        }
        sonarrCall += 1;
        if (sonarrCall === 1) {
          throw new Error('404');
        }
        return {
          tvdbId: 999999,
          id: 200,
          title: 'Unrelated Colliding Series',
          titleSlug: 'unrelated-colliding-series',
          monitored: true,
          statistics: {
            episodeFileCount: 12,
            totalEpisodeCount: 12,
            episodeCount: 12,
            percentOfEpisodes: 100,
            sizeOnDisk: 0,
            seasonCount: 1,
          },
          seasons: fakeSonarrSeasons(1, { 1: 12 }),
        } as unknown as SonarrSeries;
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 3000 },
        relations: ['seasons'],
      });

      for (const season of updated.seasons) {
        assert.strictEqual(
          season.status,
          MediaStatus.DELETED,
          `Season ${season.seasonNumber} should be DELETED (collision must not keep it available) but was ${season.status}`
        );
      }

      assert.strictEqual(
        updated.status,
        MediaStatus.DELETED,
        'Show deleted from its origin instance and Plex must not be kept alive by a colliding externalServiceId on another standard instance'
      );
    });

    it('should assume season exists when getChildrenMetadata fails for episodes (safe fallback)', async () => {
      configurePlex();
      configureSonarr([{ syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 2001;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.ratingKey = 'plex-house2-rk';
      media.externalServiceId = 201;
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];

      await mediaRepository.save(media);

      getMetadataImpl = async (key: string) => {
        if (key === 'plex-house2-rk') {
          return fakePlexShow('plex-house2-rk');
        }
        throw new Error('404');
      };

      getChildrenMetadataImpl = async (key: string) => {
        if (key === 'plex-house2-rk') {
          return [fakePlexSeason(1, 'plex-house2-s1-rk')];
        }
        throw new Error('Connection refused');
      };

      getSeriesByIdImpl = async (id: number) => {
        if (id === 201) {
          return {
            tvdbId: 99999,
            id: 201,
            title: 'House 2',
            titleSlug: 'house-2',
            monitored: true,
            statistics: {
              episodeFileCount: 10,
              totalEpisodeCount: 10,
              episodeCount: 10,
              percentOfEpisodes: 100,
              sizeOnDisk: 0,
              seasonCount: 1,
            },
            seasons: fakeSonarrSeasons(1, { 1: 10 }),
          } as unknown as SonarrSeries;
        }
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 2001 },
        relations: ['seasons'],
      });

      assert.strictEqual(
        updated.seasons[0].status,
        MediaStatus.AVAILABLE,
        'Season should remain AVAILABLE when getChildrenMetadata fails'
      );
      assert.strictEqual(
        updated.status,
        MediaStatus.AVAILABLE,
        'Show should remain AVAILABLE when getChildrenMetadata fails'
      );
    });

    it('should mark deleted seasons when only some seasons have episodes in Plex (no Sonarr link)', async () => {
      configurePlex();
      configureSonarr([{ syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 2002;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.ratingKey = 'plex-house3-rk';
      media.externalServiceId = undefined as unknown as number;
      media.seasons = [];

      for (let i = 1; i <= 4; i++) {
        media.seasons.push(
          new Season({
            seasonNumber: i,
            status: MediaStatus.AVAILABLE,
            status4k: MediaStatus.UNKNOWN,
          })
        );
      }

      await mediaRepository.save(media);

      getMetadataImpl = async (key: string) => {
        if (key === 'plex-house3-rk') {
          return fakePlexShow('plex-house3-rk');
        }
        throw new Error('404');
      };

      getChildrenMetadataImpl = async (key: string) => {
        if (key === 'plex-house3-rk') {
          return Array.from({ length: 4 }, (_, i) =>
            fakePlexSeason(i + 1, `plex-house3-s${i + 1}-rk`)
          );
        }
        // Only seasons 2 and 4 have episodes
        if (key === 'plex-house3-s2-rk' || key === 'plex-house3-s4-rk') {
          return fakePlexEpisodes(10);
        }
        return [];
      };

      getSeriesByIdImpl = async () => {
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 2002 },
        relations: ['seasons'],
      });

      const s2 = updated.seasons.find((s) => s.seasonNumber === 2);
      const s4 = updated.seasons.find((s) => s.seasonNumber === 4);
      assert.strictEqual(
        s2?.status,
        MediaStatus.AVAILABLE,
        'Season 2 should remain AVAILABLE'
      );
      assert.strictEqual(
        s4?.status,
        MediaStatus.AVAILABLE,
        'Season 4 should remain AVAILABLE'
      );

      const s1 = updated.seasons.find((s) => s.seasonNumber === 1);
      const s3 = updated.seasons.find((s) => s.seasonNumber === 3);
      assert.strictEqual(
        s1?.status,
        MediaStatus.DELETED,
        'Season 1 should be DELETED'
      );
      assert.strictEqual(
        s3?.status,
        MediaStatus.DELETED,
        'Season 3 should be DELETED'
      );

      assert.strictEqual(
        updated.status,
        MediaStatus.PARTIALLY_AVAILABLE,
        'Show should be PARTIALLY_AVAILABLE after season removal'
      );
    });
  });

  describe('movie availability - Radarr', () => {
    it('should mark a deleted movie as DELETED when a second standard Radarr instance has a colliding externalServiceId', async () => {
      configurePlex();
      configureRadarr([{ syncEnabled: true }, { syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 5000;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.AVAILABLE;
      media.ratingKey = 'gone-from-plex-rk';
      media.externalServiceId = 300;
      media.serviceId = 0;

      await mediaRepository.save(media);

      // Probed once per standard instance with the same id (300): origin 404s
      // (deleted); the other instance has a different movie at 300.
      let radarrCall = 0;
      getMovieImpl = async (id: number) => {
        if (id !== 300) {
          throw new Error('404');
        }
        radarrCall += 1;
        if (radarrCall === 1) {
          throw new Error('404');
        }
        return {
          id: 300,
          tmdbId: 999999,
          title: 'Unrelated Colliding Movie',
          hasFile: true,
        } as unknown as RadarrMovie;
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 5000 },
      });

      assert.strictEqual(
        updated.status,
        MediaStatus.DELETED,
        'Movie deleted from its origin instance and Plex must not be kept alive by a colliding externalServiceId on another standard instance'
      );
    });
  });

  describe('movie availability - Plex 4K detection', () => {
    function fakePlexMovie(ratingKey: string, widths: number[]): PlexMetadata {
      return {
        ratingKey,
        guid: `plex://movie/${ratingKey}`,
        type: 'movie',
        title: 'Test Movie',
        Guid: [],
        index: 1,
        leafCount: 0,
        viewedLeafCount: 0,
        addedAt: 0,
        updatedAt: 0,
        Media: widths.map((width, i) => ({
          id: i,
          duration: 7200,
          bitrate: 20000,
          width,
          height: width >= 2000 ? 2160 : 1080,
          aspectRatio: 1.78,
          audioChannels: 6,
          audioCodec: 'eac3',
          videoCodec: width >= 2000 ? 'hevc' : 'h264',
          videoResolution: width >= 2000 ? '4k' : '1080',
          container: 'mkv',
          videoFrameRate: '24p',
          videoProfile: 'main 10',
        })),
      };
    }

    it('should keep the 4K status when both statuses share a Plex item that has a 4K version (merged versions)', async () => {
      configurePlex();
      configureRadarr([
        { syncEnabled: true },
        { is4k: true, syncEnabled: true },
      ]);

      const mediaRepository = getRepository(Media);

      // The Plex scanner writes the same rating key to both versions of a
      // merged item, and a prior deletion left no externalServiceId4k to
      // query, so retention rides on the Plex check alone.
      const media = new Media();
      media.tmdbId = 687163;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.AVAILABLE;
      media.status4k = MediaStatus.AVAILABLE;
      media.ratingKey = 'merged-versions-rk';
      media.ratingKey4k = 'merged-versions-rk';
      await mediaRepository.save(media);

      getMetadataImpl = async (key: string) => {
        if (key === 'merged-versions-rk') {
          return fakePlexMovie('merged-versions-rk', [1920, 3840]);
        }
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 687163 },
      });

      assert.strictEqual(
        updated.status4k,
        MediaStatus.AVAILABLE,
        'A 4K version present on the media server must prevent 4K removal even when both statuses share one rating key'
      );
      assert.strictEqual(
        updated.status,
        MediaStatus.AVAILABLE,
        'The non-4K status must be unaffected'
      );
    });

    it('should still remove a stale 4K status when the shared Plex item has no 4K version', async () => {
      configurePlex();
      configureRadarr([
        { syncEnabled: true },
        { is4k: true, syncEnabled: true },
      ]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 687164;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.AVAILABLE;
      media.status4k = MediaStatus.AVAILABLE;
      media.ratingKey = 'stale-4k-rk';
      media.ratingKey4k = 'stale-4k-rk';
      await mediaRepository.save(media);

      getMetadataImpl = async (key: string) => {
        if (key === 'stale-4k-rk') {
          return fakePlexMovie('stale-4k-rk', [1920]);
        }
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 687164 },
      });

      assert.strictEqual(
        updated.status4k,
        MediaStatus.DELETED,
        'A phantom 4K status on a 1080p-only item must still be removed'
      );
      assert.strictEqual(
        updated.status,
        MediaStatus.AVAILABLE,
        'The non-4K status must be kept'
      );
    });

    it('should keep a 4K-only movie referenced only by ratingKey4k', async () => {
      configurePlex();
      configureRadarr([
        { syncEnabled: true },
        { is4k: true, syncEnabled: true },
      ]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 687165;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.UNKNOWN;
      media.status4k = MediaStatus.AVAILABLE;
      media.ratingKey4k = 'pure-4k-rk';
      await mediaRepository.save(media);

      getMetadataImpl = async (key: string) => {
        if (key === 'pure-4k-rk') {
          return fakePlexMovie('pure-4k-rk', [3840]);
        }
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 687165 },
      });

      assert.strictEqual(
        updated.status4k,
        MediaStatus.AVAILABLE,
        'A 4K-only item with a distinct rating key must be kept'
      );
    });

    it('should not remove a 4K movie when Plex has not yet analyzed the file (empty Media array)', async () => {
      configurePlex();
      configureRadarr([{ is4k: true, syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 687166;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.UNKNOWN;
      media.status4k = MediaStatus.AVAILABLE;
      media.ratingKey4k = 'analyzing-rk';
      await mediaRepository.save(media);

      getMetadataImpl = async (key: string) => {
        if (key === 'analyzing-rk') {
          return fakePlexMovie('analyzing-rk', []);
        }
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 687166 },
      });

      assert.strictEqual(
        updated.status4k,
        MediaStatus.AVAILABLE,
        'Metadata without analyzed versions proves nothing about the file and must not trigger removal'
      );
    });

    it('should remove the non-4K status when the shared Plex item only has a 4K version left', async () => {
      configurePlex();
      configureRadarr([
        { syncEnabled: true },
        { is4k: true, syncEnabled: true },
      ]);

      const mediaRepository = getRepository(Media);

      // Merged item whose non-4K file was removed from disk: the item still
      // exists in Plex, but only with the 4K version.
      const media = new Media();
      media.tmdbId = 687170;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.AVAILABLE;
      media.status4k = MediaStatus.AVAILABLE;
      media.ratingKey = 'shared-4k-only-rk';
      media.ratingKey4k = 'shared-4k-only-rk';
      await mediaRepository.save(media);

      getMetadataImpl = async (key: string) => {
        if (key === 'shared-4k-only-rk') {
          return fakePlexMovie('shared-4k-only-rk', [3840]);
        }
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 687170 },
      });

      assert.strictEqual(
        updated.status,
        MediaStatus.DELETED,
        'The non-4K status must be removed when the shared item no longer has a non-4K version'
      );
      assert.strictEqual(
        updated.status4k,
        MediaStatus.AVAILABLE,
        'The 4K status must be kept'
      );
    });
  });

  describe('movie deletion metadata handling', () => {
    it('should keep service metadata when deleting a 4K movie with an approved 4K request in flight', async () => {
      configurePlex();
      configureRadarr([{ is4k: true, syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 687167;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.UNKNOWN;
      media.status4k = MediaStatus.AVAILABLE;
      media.ratingKey4k = 'req-in-flight-rk';
      media.serviceId4k = 0;
      media.externalServiceId4k = 512;
      media.externalServiceSlug4k = 'test-movie';
      await mediaRepository.save(media);

      // Insert through a query builder with listeners disabled so
      // MediaRequestSubscriber.afterInsert does not try to reach Radarr.
      await getRepository(MediaRequest)
        .createQueryBuilder()
        .insert()
        .into(MediaRequest)
        .values({
          status: MediaRequestStatus.APPROVED,
          media: { id: media.id },
          requestedBy: { id: 1 },
          type: MediaType.MOVIE,
          is4k: true,
        })
        .callListeners(false)
        .execute();

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 687167 },
      });

      assert.strictEqual(updated.status4k, MediaStatus.DELETED);
      assert.strictEqual(
        updated.externalServiceId4k,
        512,
        'externalServiceId4k must be kept while an approved 4K request is in flight'
      );
      assert.strictEqual(updated.serviceId4k, 0);
      assert.strictEqual(updated.externalServiceSlug4k, 'test-movie');
      assert.strictEqual(
        updated.ratingKey4k,
        'req-in-flight-rk',
        'ratingKey4k must be kept while an approved 4K request is in flight'
      );
    });

    it('should null service metadata when deleting a 4K movie with no open request', async () => {
      configurePlex();
      configureRadarr([{ is4k: true, syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 687168;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.UNKNOWN;
      media.status4k = MediaStatus.AVAILABLE;
      media.ratingKey4k = 'no-request-rk';
      media.serviceId4k = 0;
      media.externalServiceId4k = 640;
      media.externalServiceSlug4k = 'another-movie';
      await mediaRepository.save(media);

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 687168 },
      });

      assert.strictEqual(updated.status4k, MediaStatus.DELETED);
      assert.strictEqual(updated.externalServiceId4k, null);
      assert.strictEqual(updated.serviceId4k, null);
      assert.strictEqual(updated.externalServiceSlug4k, null);
      assert.strictEqual(updated.ratingKey4k, null);
    });
  });

  describe('movie availability - scan-disabled servers', () => {
    it('should count a configured but scan-disabled 4K Radarr server as existence evidence', async () => {
      configurePlex();
      configureRadarr([
        { syncEnabled: true },
        { is4k: true, syncEnabled: false, port: 7879 },
      ]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 687169;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.UNKNOWN;
      media.status4k = MediaStatus.AVAILABLE;
      media.ratingKey4k = 'not-in-plex-rk';
      media.serviceId4k = 1;
      media.externalServiceId4k = 700;
      await mediaRepository.save(media);

      getMovieImpl = async (id: number) => {
        if (id !== 700) {
          throw new Error('404');
        }
        return {
          id: 700,
          tmdbId: 687169,
          title: 'Test Movie',
          hasFile: true,
        } as unknown as RadarrMovie;
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 687169 },
      });

      assert.strictEqual(
        updated.status4k,
        MediaStatus.AVAILABLE,
        'A movie present on a configured 4K Radarr server must be kept even when that server has scanning disabled'
      );
    });
  });

  describe('show availability - merged Plex versions', () => {
    function fakeVersionedEpisode(
      ratingKey: string,
      widths: number[]
    ): PlexMetadata {
      return {
        ratingKey,
        guid: `plex://episode/${ratingKey}`,
        type: 'movie' as const,
        title: ratingKey,
        Guid: [],
        index: 1,
        leafCount: 0,
        viewedLeafCount: 0,
        addedAt: 0,
        updatedAt: 0,
        Media: widths.map((width, i) => ({
          id: i,
          duration: 2400,
          bitrate: width >= 2000 ? 20000 : 4000,
          width,
          height: width >= 2000 ? 2160 : 1080,
          aspectRatio: 1.78,
          audioChannels: 6,
          audioCodec: 'eac3',
          videoCodec: width >= 2000 ? 'hevc' : 'h264',
          videoResolution: width >= 2000 ? '4k' : '1080',
          container: 'mkv',
          videoFrameRate: '24p',
          videoProfile: width >= 2000 ? 'main 10' : 'high',
        })),
      };
    }

    it('should remove a stale 4K season status when the shared item has no 4K episodes for that season', async () => {
      configurePlex();
      configureSonarr([
        { syncEnabled: true },
        { is4k: true, syncEnabled: true },
      ]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 687171;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.status4k = MediaStatus.AVAILABLE;
      media.ratingKey = 'merged-show-rk';
      media.ratingKey4k = 'merged-show-rk';
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.AVAILABLE,
        }),
        new Season({
          seasonNumber: 2,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.AVAILABLE,
        }),
      ];
      await mediaRepository.save(media);

      getMetadataImpl = async (key: string) => {
        if (key === 'merged-show-rk') {
          return fakePlexShow('merged-show-rk');
        }
        throw new Error('404');
      };

      // Season 1 has a 4K version, season 2 only has a 1080p file left.
      getChildrenMetadataImpl = async (key: string) => {
        if (key === 'merged-show-rk') {
          return [fakePlexSeason(1, 'ms-s1-rk'), fakePlexSeason(2, 'ms-s2-rk')];
        }
        if (key === 'ms-s1-rk') {
          return [fakeVersionedEpisode('ms-s1-e1', [1920, 3840])];
        }
        if (key === 'ms-s2-rk') {
          return [fakeVersionedEpisode('ms-s2-e1', [1920])];
        }
        return [];
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 687171 },
        relations: ['seasons'],
      });
      const s1 = updated.seasons.find((s) => s.seasonNumber === 1);
      const s2 = updated.seasons.find((s) => s.seasonNumber === 2);

      assert.strictEqual(
        s2?.status4k,
        MediaStatus.DELETED,
        'A 4K season status without any 4K episode on the shared item must be removed'
      );
      assert.strictEqual(
        s1?.status4k,
        MediaStatus.AVAILABLE,
        'A season with a 4K episode must be kept'
      );
      assert.strictEqual(
        updated.status4k,
        MediaStatus.PARTIALLY_AVAILABLE,
        'The 4K show must roll up to partially available'
      );
      assert.strictEqual(s1?.status, MediaStatus.AVAILABLE);
      assert.strictEqual(s2?.status, MediaStatus.AVAILABLE);
      assert.strictEqual(updated.status, MediaStatus.AVAILABLE);
    });

    it('should remove a stale non-4K season status when the shared item only has 4K episodes for that season', async () => {
      configurePlex();
      configureSonarr([
        { syncEnabled: true },
        { is4k: true, syncEnabled: true },
      ]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 687172;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.status4k = MediaStatus.AVAILABLE;
      media.ratingKey = 'merged-show2-rk';
      media.ratingKey4k = 'merged-show2-rk';
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.AVAILABLE,
        }),
        new Season({
          seasonNumber: 2,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.AVAILABLE,
        }),
      ];
      await mediaRepository.save(media);

      getMetadataImpl = async (key: string) => {
        if (key === 'merged-show2-rk') {
          return fakePlexShow('merged-show2-rk');
        }
        throw new Error('404');
      };

      // Season 2's non-4K file was removed; only the 4K version remains.
      getChildrenMetadataImpl = async (key: string) => {
        if (key === 'merged-show2-rk') {
          return [
            fakePlexSeason(1, 'ms2-s1-rk'),
            fakePlexSeason(2, 'ms2-s2-rk'),
          ];
        }
        if (key === 'ms2-s1-rk') {
          return [fakeVersionedEpisode('ms2-s1-e1', [1920, 3840])];
        }
        if (key === 'ms2-s2-rk') {
          return [fakeVersionedEpisode('ms2-s2-e1', [3840])];
        }
        return [];
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 687172 },
        relations: ['seasons'],
      });
      const s1 = updated.seasons.find((s) => s.seasonNumber === 1);
      const s2 = updated.seasons.find((s) => s.seasonNumber === 2);

      assert.strictEqual(
        s2?.status,
        MediaStatus.DELETED,
        'A non-4K season status without any non-4K episode on the shared item must be removed'
      );
      assert.strictEqual(
        s2?.status4k,
        MediaStatus.AVAILABLE,
        'The 4K season status must be kept'
      );
      assert.strictEqual(
        updated.status,
        MediaStatus.PARTIALLY_AVAILABLE,
        'The non-4K show must roll up to partially available'
      );
      assert.strictEqual(s1?.status, MediaStatus.AVAILABLE);
      assert.strictEqual(s1?.status4k, MediaStatus.AVAILABLE);
      assert.strictEqual(updated.status4k, MediaStatus.AVAILABLE);
    });

    it('should keep a non-4K season with only 4K episodes when no 4K Sonarr server is configured', async () => {
      // Single-server setups track 4K files under the plain status;
      // without a 4K Sonarr the resolution check must stay disabled.
      configurePlex();
      configureSonarr([{ syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 687173;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.ratingKey = 'single-4k-show-rk';
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];
      await mediaRepository.save(media);

      getMetadataImpl = async (key: string) => {
        if (key === 'single-4k-show-rk') {
          return fakePlexShow('single-4k-show-rk');
        }
        throw new Error('404');
      };

      getChildrenMetadataImpl = async (key: string) => {
        if (key === 'single-4k-show-rk') {
          return [fakePlexSeason(1, 's4k-s1-rk')];
        }
        if (key === 's4k-s1-rk') {
          return [fakeVersionedEpisode('s4k-s1-e1', [3840])];
        }
        return [];
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 687173 },
        relations: ['seasons'],
      });
      const s1 = updated.seasons.find((s) => s.seasonNumber === 1);

      assert.strictEqual(
        s1?.status,
        MediaStatus.AVAILABLE,
        'Without a 4K Sonarr server a 4K-only season must keep its non-4K status'
      );
      assert.strictEqual(updated.status, MediaStatus.AVAILABLE);
    });

    it('should not remove the 4K show status when episode metadata cannot be fetched for any season', async () => {
      configurePlex();
      configureSonarr([
        { syncEnabled: true },
        { is4k: true, syncEnabled: true },
      ]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 687174;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.status4k = MediaStatus.AVAILABLE;
      media.ratingKey = 'merged-show3-rk';
      media.ratingKey4k = 'merged-show3-rk';
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.AVAILABLE,
        }),
      ];
      await mediaRepository.save(media);

      getMetadataImpl = async (key: string) => {
        if (key === 'merged-show3-rk') {
          return fakePlexShow('merged-show3-rk');
        }
        throw new Error('404');
      };

      getChildrenMetadataImpl = async (key: string) => {
        if (key === 'merged-show3-rk') {
          return [fakePlexSeason(1, 'ms3-s1-rk')];
        }
        throw new Error('episode fetch failed');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 687174 },
        relations: ['seasons'],
      });
      const s1 = updated.seasons.find((s) => s.seasonNumber === 1);

      assert.strictEqual(
        updated.status4k,
        MediaStatus.AVAILABLE,
        'Unverifiable episode metadata proves nothing about the files and must not trigger 4K removal'
      );
      assert.strictEqual(s1?.status4k, MediaStatus.AVAILABLE);
      assert.strictEqual(updated.status, MediaStatus.AVAILABLE);
      assert.strictEqual(s1?.status, MediaStatus.AVAILABLE);
    });
  });

  describe('specials season handling', () => {
    const tmdbSeasonsWithSpecials = [
      {
        id: 100,
        air_date: '2024-01-01',
        episode_count: 3,
        name: 'Specials',
        overview: '',
        season_number: 0,
      },
      {
        id: 101,
        air_date: '2024-01-01',
        episode_count: 10,
        name: 'Season 1',
        overview: '',
        season_number: 1,
      },
    ];

    it('should not demote an available show when only the specials season is missing (Jellyfin)', async () => {
      configureJellyfin();
      configureSonarr([{ syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 13862;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.jellyfinMediaId = 'jellyfin-shogun-id';
      media.externalServiceId = 300;
      media.seasons = [
        new Season({
          seasonNumber: 0,
          status: MediaStatus.UNKNOWN,
          status4k: MediaStatus.UNKNOWN,
        }),
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];

      await mediaRepository.save(media);

      getTvShowImpl = async () => fakeTmdbShow(13862, tmdbSeasonsWithSpecials);

      getItemDataImpl = async (id: string) => {
        if (id === 'jellyfin-shogun-id') {
          return fakeJellyfinShow('jellyfin-shogun-id', '13862');
        }
        return undefined;
      };

      getSeasonsImpl = async (seriesID: string) => {
        if (seriesID === 'jellyfin-shogun-id') {
          return [fakeJellyfinSeason(1, 'jellyfin-shogun-s1-id')];
        }
        return [];
      };

      getEpisodesImpl = async (_seriesID: string, seasonID: string) => {
        if (seasonID === 'jellyfin-shogun-s1-id') {
          return fakeJellyfinEpisodes(10);
        }
        return [];
      };

      getSeriesByIdImpl = async (id: number) => {
        if (id === 300) {
          return {
            tvdbId: 70814,
            id: 300,
            title: 'Shogun',
            titleSlug: 'shogun',
            monitored: true,
            statistics: {
              episodeFileCount: 10,
              totalEpisodeCount: 10,
              episodeCount: 10,
              percentOfEpisodes: 100,
              sizeOnDisk: 0,
              seasonCount: 1,
            },
            seasons: fakeSonarrSeasons(1, { 1: 10 }),
          } as unknown as SonarrSeries;
        }
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 13862 },
        relations: ['seasons'],
      });

      assert.strictEqual(
        updated.status,
        MediaStatus.AVAILABLE,
        'Show should stay AVAILABLE when only the specials season is missing'
      );
    });

    it('should not demote an available show when only the specials season is missing (Plex)', async () => {
      configurePlex();
      configureSonarr([{ syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 13863;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.ratingKey = 'plex-shogun-rk';
      media.externalServiceId = 301;
      media.seasons = [
        new Season({
          seasonNumber: 0,
          status: MediaStatus.UNKNOWN,
          status4k: MediaStatus.UNKNOWN,
        }),
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];

      await mediaRepository.save(media);

      getTvShowImpl = async () => fakeTmdbShow(13863, tmdbSeasonsWithSpecials);

      getMetadataImpl = async (key: string) => {
        if (key === 'plex-shogun-rk') {
          return fakePlexShow('plex-shogun-rk');
        }
        throw new Error('404');
      };

      getChildrenMetadataImpl = async (key: string) => {
        if (key === 'plex-shogun-rk') {
          return [fakePlexSeason(1, 'plex-shogun-s1-rk')];
        }
        if (key === 'plex-shogun-s1-rk') {
          return fakePlexEpisodes(10);
        }
        return [];
      };

      getSeriesByIdImpl = async (id: number) => {
        if (id === 301) {
          return {
            tvdbId: 70814,
            id: 301,
            title: 'Shogun',
            titleSlug: 'shogun',
            monitored: true,
            statistics: {
              episodeFileCount: 10,
              totalEpisodeCount: 10,
              episodeCount: 10,
              percentOfEpisodes: 100,
              sizeOnDisk: 0,
              seasonCount: 1,
            },
            seasons: fakeSonarrSeasons(1, { 1: 10 }),
          } as unknown as SonarrSeries;
        }
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 13863 },
        relations: ['seasons'],
      });

      assert.strictEqual(
        updated.status,
        MediaStatus.AVAILABLE,
        'Show should stay AVAILABLE when only the specials season is missing'
      );
    });

    it('should mark a removed specials season as DELETED without demoting the show (Jellyfin)', async () => {
      configureJellyfin();
      configureSonarr([{ syncEnabled: true }]);

      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 13864;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.jellyfinMediaId = 'jellyfin-specials-id';
      media.externalServiceId = 302;
      media.seasons = [
        new Season({
          seasonNumber: 0,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];

      await mediaRepository.save(media);

      getTvShowImpl = async () => fakeTmdbShow(13864, tmdbSeasonsWithSpecials);

      getItemDataImpl = async (id: string) => {
        if (id === 'jellyfin-specials-id') {
          return fakeJellyfinShow('jellyfin-specials-id', '13864');
        }
        return undefined;
      };

      getSeasonsImpl = async (seriesID: string) => {
        if (seriesID === 'jellyfin-specials-id') {
          return [fakeJellyfinSeason(1, 'jellyfin-specials-s1-id')];
        }
        return [];
      };

      getEpisodesImpl = async (_seriesID: string, seasonID: string) => {
        if (seasonID === 'jellyfin-specials-s1-id') {
          return fakeJellyfinEpisodes(10);
        }
        return [];
      };

      getSeriesByIdImpl = async (id: number) => {
        if (id === 302) {
          return {
            tvdbId: 70814,
            id: 302,
            title: 'Shogun',
            titleSlug: 'shogun',
            monitored: true,
            statistics: {
              episodeFileCount: 10,
              totalEpisodeCount: 10,
              episodeCount: 10,
              percentOfEpisodes: 100,
              sizeOnDisk: 0,
              seasonCount: 1,
            },
            seasons: fakeSonarrSeasons(1, { 1: 10 }),
          } as unknown as SonarrSeries;
        }
        throw new Error('404');
      };

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 13864 },
        relations: ['seasons'],
      });

      const specials = updated.seasons.find((s) => s.seasonNumber === 0);
      assert.strictEqual(
        specials?.status,
        MediaStatus.DELETED,
        'Removed specials season should be marked DELETED'
      );

      assert.strictEqual(
        updated.status,
        MediaStatus.AVAILABLE,
        'Show should stay AVAILABLE when only specials were removed'
      );
    });
  });

  describe('blocklisted titles', () => {
    it('keeps a blocklisted show blocklisted once its files are gone', async () => {
      configurePlex();
      configureSonarr([{ syncEnabled: true }]);

      const mediaRepository = getRepository(Media);
      const media = new Media();
      media.tmdbId = 4500;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.BLOCKLISTED;
      media.status4k = MediaStatus.BLOCKLISTED;
      media.ratingKey = 'plex-blocked';
      media.externalServiceId = 450;
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];
      await mediaRepository.save(media);

      await availabilitySync.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 4500 },
      });
      assert.equal(updated.status, MediaStatus.BLOCKLISTED);
      assert.equal(updated.status4k, MediaStatus.BLOCKLISTED);
    });
  });

  describe('running', () => {
    it('does not start a second run while one is under way', async () => {
      configurePlex();
      configureSonarr([{ syncEnabled: true }]);

      const media = new Media();
      media.tmdbId = 4600;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.externalServiceId = 460;
      media.seasons = [];
      await getRepository(Media).save(media);

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let lookups = 0;
      getSeriesByIdImpl = async () => {
        lookups++;
        if (lookups === 1) await gate;
        throw new Error('404');
      };

      const first = availabilitySync.run();
      while (lookups === 0) await new Promise((r) => setImmediate(r));

      await availabilitySync.run();
      assert.equal(lookups, 1, 'the second run looked titles up again');
      assert.equal(availabilitySync.running, true);

      release();
      await first;
      assert.equal(availabilitySync.running, false);
    });

    it('checks every title, however many drop out as it goes', async () => {
      configurePlex();
      configureRadarr([{ syncEnabled: true }]);

      // More than a page of movies, none of them still on disk anywhere.
      const mediaRepository = getRepository(Media);
      await mediaRepository.save(
        Array.from({ length: 60 }, (_, i) => {
          const media = new Media();
          media.tmdbId = 5000 + i;
          media.mediaType = MediaType.MOVIE;
          media.status = MediaStatus.AVAILABLE;
          return media;
        })
      );

      await availabilitySync.run();

      assert.equal(
        await mediaRepository.count({
          where: { status: MediaStatus.AVAILABLE },
        }),
        0
      );
    });
  });

  describe('media server unreachable', () => {
    // A show whose four seasons are all here, only season 1 of which Sonarr
    // has files for: the rest came from somewhere else.
    const saveShow = async (fields: Partial<Media>) => {
      const media = new Media();
      media.tmdbId = 4700;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.externalServiceId = 470;
      Object.assign(media, fields);
      media.seasons = [1, 2, 3, 4].map(
        (seasonNumber) =>
          new Season({
            seasonNumber,
            status: MediaStatus.AVAILABLE,
            status4k: MediaStatus.UNKNOWN,
          })
      );
      await getRepository(Media).save(media);

      getSeriesByIdImpl = async (id: number) => {
        if (id !== 470) throw new Error('404');
        return {
          tvdbId: 47000,
          id: 470,
          title: 'Test Show',
          titleSlug: 'test-show',
          monitored: true,
          statistics: {
            episodeFileCount: 10,
            totalEpisodeCount: 40,
            episodeCount: 40,
            percentOfEpisodes: 25,
            sizeOnDisk: 0,
            seasonCount: 4,
          },
          seasons: fakeSonarrSeasons(4, { 1: 10 }),
        } as unknown as SonarrSeries;
      };
    };

    const seasonsOf = async () => {
      const media = await getRepository(Media).findOneOrFail({
        where: { tmdbId: 4700 },
        relations: ['seasons'],
      });
      return {
        status: media.status,
        seasons: media.seasons
          .sort((a, b) => a.seasonNumber - b.seasonNumber)
          .map((season) => season.status),
      };
    };

    const untouched = {
      status: MediaStatus.AVAILABLE,
      seasons: [1, 2, 3, 4].map(() => MediaStatus.AVAILABLE),
    };

    it('keeps the seasons when Plex fails to answer for a show', async () => {
      configurePlex();
      configureSonarr([{ syncEnabled: true }]);
      await saveShow({ ratingKey: 'plex-down-rk' });
      getMetadataImpl = async () => {
        throw new Error('Request failed with status code 503');
      };

      await availabilitySync.run();

      assert.deepStrictEqual(await seasonsOf(), untouched);
    });

    it('keeps the seasons when Jellyfin fails to answer for a show', async () => {
      configureJellyfin();
      configureSonarr([{ syncEnabled: true }]);
      await saveShow({ jellyfinMediaId: 'jf-down-id' });
      getItemDataImpl = async () => {
        throw new ApiError(502, ApiErrorCode.ConnectionError);
      };

      await availabilitySync.run();

      assert.deepStrictEqual(await seasonsOf(), untouched);
    });

    it('still marks seasons Plex no longer has once it answers', async () => {
      configurePlex();
      configureSonarr([{ syncEnabled: true }]);
      await saveShow({ ratingKey: 'plex-up-rk' });
      getMetadataImpl = async (key: string) => {
        if (key === 'plex-up-rk') return fakePlexShow('plex-up-rk');
        throw new Error('404');
      };
      getChildrenMetadataImpl = async (key: string) =>
        key === 'plex-up-rk'
          ? [1, 2, 3, 4].map((n) => fakePlexSeason(n, `plex-up-s${n}`))
          : key === 'plex-up-s2'
            ? fakePlexEpisodes(10)
            : [];

      await availabilitySync.run();

      assert.deepStrictEqual(await seasonsOf(), {
        status: MediaStatus.PARTIALLY_AVAILABLE,
        seasons: [
          MediaStatus.AVAILABLE,
          MediaStatus.AVAILABLE,
          MediaStatus.DELETED,
          MediaStatus.DELETED,
        ],
      });
    });

    it('checks nothing while Plex cannot be reached', async () => {
      configurePlex();
      configureRadarr([{ syncEnabled: true }]);
      const media = new Media();
      media.tmdbId = 4800;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.AVAILABLE;
      media.ratingKey = 'plex-unreachable-rk';
      await getRepository(Media).save(media);
      getStatusImpl = async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:32400');
      };

      await availabilitySync.run();

      const updated = await getRepository(Media).findOneByOrFail({
        tmdbId: 4800,
      });
      assert.strictEqual(updated.status, MediaStatus.AVAILABLE);
      assert.strictEqual(availabilitySync.running, false);
    });

    it('checks nothing while no Plex admin is signed in', async () => {
      configurePlex();
      configureRadarr([{ syncEnabled: true }]);
      await getRepository(User).update(1, { plexToken: null });
      const media = new Media();
      media.tmdbId = 4801;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.AVAILABLE;
      await getRepository(Media).save(media);

      await availabilitySync.run();

      const updated = await getRepository(Media).findOneByOrFail({
        tmdbId: 4801,
      });
      assert.strictEqual(updated.status, MediaStatus.AVAILABLE);
    });
  });

  describe('several media servers', () => {
    const saveMovie = async (tmdbId: number, fields: Partial<Media>) => {
      const media = new Media();
      media.tmdbId = tmdbId;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.AVAILABLE;
      Object.assign(media, fields);
      await getRepository(Media).save(media);
    };

    const reload = (tmdbId: number) =>
      getRepository(Media).findOneByOrFail({ tmdbId });

    const jellyfinMovie = (id: string): JellyfinLibraryItemExtended => ({
      ...fakeJellyfinShow(id, '0'),
      Type: 'Movie',
    });

    it('keeps a movie another server still has, without the dead link', async () => {
      connectServers('plex', 'jellyfin');
      configureRadarr([{ syncEnabled: true }]);
      await saveMovie(4900, {
        ratingKey: 'plex-gone-rk',
        jellyfinMediaId: 'jf-here-id',
      });
      // Plex answers 404 for its id; Jellyfin has the movie.
      getItemDataImpl = async (id) =>
        id === 'jf-here-id' ? jellyfinMovie(id) : undefined;

      await availabilitySync.run();

      const media = await reload(4900);
      assert.equal(media.status, MediaStatus.AVAILABLE);
      assert.equal(media.ratingKey, null);
      assert.equal(media.jellyfinMediaId, 'jf-here-id');
    });

    it('marks a movie no server has deleted, and forgets every id', async () => {
      connectServers('jellyfin', 'plex');
      configureRadarr([{ syncEnabled: true }]);
      await saveMovie(4901, {
        ratingKey: 'plex-gone-rk',
        jellyfinMediaId: 'jf-gone-id',
      });

      await availabilitySync.run();

      const media = await reload(4901);
      assert.equal(media.status, MediaStatus.DELETED);
      assert.equal(media.ratingKey, null);
      assert.equal(media.jellyfinMediaId, null);
    });

    it('keeps the id of a server that could not answer for the title', async () => {
      connectServers('plex', 'jellyfin');
      configureRadarr([{ syncEnabled: true }]);
      await saveMovie(4902, {
        ratingKey: 'plex-busy-rk',
        jellyfinMediaId: 'jf-here-id',
      });
      getMetadataImpl = async () => {
        throw new Error('Request failed with status code 503');
      };
      getItemDataImpl = async (id) =>
        id === 'jf-here-id' ? jellyfinMovie(id) : undefined;

      await availabilitySync.run();

      const media = await reload(4902);
      assert.equal(media.status, MediaStatus.AVAILABLE);
      assert.equal(media.ratingKey, 'plex-busy-rk');
    });

    it('counts a season on any server', async () => {
      connectServers('plex', 'jellyfin');
      configureSonarr([{ syncEnabled: true }]);
      const media = new Media();
      media.tmdbId = 4910;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.ratingKey = 'plex-show-rk';
      media.jellyfinMediaId = 'jf-show-id';
      media.seasons = [1, 2, 3, 4].map(
        (seasonNumber) =>
          new Season({
            seasonNumber,
            status: MediaStatus.AVAILABLE,
            status4k: MediaStatus.UNKNOWN,
          })
      );
      await getRepository(Media).save(media);

      // Plex has seasons 1 and 2, Jellyfin season 3, nobody season 4.
      getMetadataImpl = async (key) => {
        if (key === 'plex-show-rk') return fakePlexShow(key);
        throw new Error('404');
      };
      getChildrenMetadataImpl = async (key) =>
        key === 'plex-show-rk'
          ? [1, 2, 3, 4].map((n) => fakePlexSeason(n, `plex-s${n}`))
          : key === 'plex-s1' || key === 'plex-s2'
            ? fakePlexEpisodes(5)
            : [];
      getItemDataImpl = async (id) =>
        id === 'jf-show-id' ? fakeJellyfinShow(id, '4910') : undefined;
      getSeasonsImpl = async () => [
        fakeJellyfinSeason(3, 'jf-s3'),
        fakeJellyfinSeason(4, 'jf-s4'),
      ];
      getEpisodesImpl = async (_series, season) =>
        season === 'jf-s3' ? fakeJellyfinEpisodes(3) : [];

      await availabilitySync.run();

      const updated = await getRepository(Media).findOneOrFail({
        where: { tmdbId: 4910 },
        relations: ['seasons'],
      });
      assert.equal(updated.status, MediaStatus.PARTIALLY_AVAILABLE);
      assert.deepEqual(
        updated.seasons
          .sort((a, b) => a.seasonNumber - b.seasonNumber)
          .map((season) => season.status),
        [
          MediaStatus.AVAILABLE,
          MediaStatus.AVAILABLE,
          MediaStatus.AVAILABLE,
          MediaStatus.DELETED,
        ]
      );
      assert.equal(updated.ratingKey, 'plex-show-rk');
      assert.equal(updated.jellyfinMediaId, 'jf-show-id');
    });

    it('keeps a movie on Emby alone, dropping Plex and Jellyfin links', async () => {
      connectServers('plex', 'jellyfin', 'emby');
      configureRadarr([{ syncEnabled: true }]);
      await saveMovie(4920, {
        ratingKey: 'plex-gone-rk',
        jellyfinMediaId: 'jf-gone-id',
        embyMediaId: '4920',
      });
      getItemDataImpl = async (id) =>
        id === '4920' ? jellyfinMovie(id) : undefined;

      await availabilitySync.run();

      const media = await reload(4920);
      assert.equal(media.status, MediaStatus.AVAILABLE);
      assert.equal(media.ratingKey, null);
      assert.equal(media.jellyfinMediaId, null);
      assert.equal(media.embyMediaId, '4920');
    });

    it('checks nothing while any connected server cannot be reached', async () => {
      connectServers('plex', 'jellyfin', 'emby');
      configureRadarr([{ syncEnabled: true }]);
      await saveMovie(4921, { embyMediaId: 'emby-id' });
      getSystemInfoImpl = async (kind) => {
        if (kind === 'emby') {
          throw new ApiError(502, ApiErrorCode.ConnectionError);
        }
        return { ServerName: 'Test' };
      };

      await availabilitySync.run();

      const media = await reload(4921);
      assert.equal(media.status, MediaStatus.AVAILABLE);
      assert.equal(media.embyMediaId, 'emby-id');
      assert.equal(availabilitySync.running, false);
    });

    it('leaves a single server’s id alone while Radarr has the file', async () => {
      connectServers('plex');
      configureRadarr([{ syncEnabled: true }]);
      await saveMovie(4930, {
        ratingKey: 'plex-gone-rk',
        externalServiceId: 49,
      });
      getMovieImpl = async () =>
        ({ id: 49, tmdbId: 4930, hasFile: true }) as RadarrMovie;

      await availabilitySync.run();

      const media = await reload(4930);
      assert.equal(media.status, MediaStatus.AVAILABLE);
      assert.equal(media.ratingKey, 'plex-gone-rk');
    });
  });
});
