import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { UserType } from '@server/constants/user';
import dataSource, { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MusicAlbum from '@server/entity/MusicAlbum';
import { User } from '@server/entity/User';
import { rollBackOnRelease } from '@server/utils/nestedTransaction';
import gravatarUrl from 'gravatar-url';

export interface SeedDbOptions {
  /** If true, preserves existing data instead of dropping the database */
  preserveDb?: boolean;
  /** If true, runs migrations instead of synchronizing schema */
  withMigrations?: boolean;
  /** If true, permits seeding while NODE_ENV is not test */
  allowOutsideTest?: boolean;
}

// Precomputed bcrypt hash of 'test1234'. We precompute this to avoid
// having to hash the password every time we seed the database.
const TEST_USER_PASSWORD_HASH =
  '$2b$12$Z5V2P5HZgmx4/AnWFMZN1.aD5AM1NucNi.mhNTSQ9oVtmdzu7Le/a';

function assertTestDatabase(operation: string, allowOutsideTest = false): void {
  if (allowOutsideTest || process.env.NODE_ENV === 'test') {
    return;
  }

  throw new Error(
    `Refusing to ${operation} while NODE_ENV is not test: this drops every table and seeds accounts with a known password.`
  );
}

/**
 * Seeds test users into the database.
 * Assumes the database schema is already set up.
 */
async function seedTestUsers(): Promise<void> {
  const userRepository = getRepository(User);

  const admin = await userRepository.findOne({
    select: { id: true, plexId: true },
    where: { id: 1 },
  });

  // Create the admin user
  const user =
    (await userRepository.findOne({
      where: { email: 'admin@seerr.dev' },
    })) ?? new User();
  user.plexId = admin?.plexId ?? 1;
  user.plexToken = '1234';
  user.plexUsername = 'admin';
  user.username = 'admin';
  user.email = 'admin@seerr.dev';
  user.userType = UserType.PLEX;
  user.password = TEST_USER_PASSWORD_HASH;
  user.permissions = 2;
  user.avatar = gravatarUrl('admin@seerr.dev', { default: 'mm', size: 200 });
  await userRepository.save(user);

  // Create the other user
  const otherUser =
    (await userRepository.findOne({
      where: { email: 'friend@seerr.dev' },
    })) ?? new User();
  otherUser.plexId = admin?.plexId ?? 1;
  otherUser.plexToken = '1234';
  otherUser.plexUsername = 'friend';
  otherUser.username = 'friend';
  otherUser.email = 'friend@seerr.dev';
  otherUser.userType = UserType.PLEX;
  otherUser.password = TEST_USER_PASSWORD_HASH;
  otherUser.permissions = 32;
  otherUser.avatar = gravatarUrl('friend@seerr.dev', {
    default: 'mm',
    size: 200,
  });
  await userRepository.save(otherUser);
}

/**
 * Initializes the database connection and seeds test users.
 * Used by both Cypress tests and Vitest unit tests.
 */
export async function seedTestDb(options: SeedDbOptions = {}): Promise<void> {
  assertTestDatabase('seed the test database', options.allowOutsideTest);

  const dbConnection = dataSource.isInitialized
    ? dataSource
    : await dataSource.initialize();
  rollBackOnRelease(dbConnection);

  if (!options.preserveDb) {
    await dbConnection.dropDatabase();
  }

  if (options.withMigrations) {
    await dbConnection.runMigrations();
  } else {
    await dbConnection.synchronize();
  }

  await seedTestUsers();
}

/**
 * Resets the database to a clean state with seeded test users.
 * Used between tests to ensure isolation.
 * Assumes DB has been initialized.
 */
export async function resetTestDb(): Promise<void> {
  assertTestDatabase('reset the test database');

  await dataSource.synchronize(true);
  await seedTestUsers();
}

/** MusicBrainz ids the music fixtures use. */
export const MUSIC_FIXTURE_IDS = {
  /** An artist with albums in the library and a request in each status. */
  artist: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
  album: 'b1392450-e666-3926-a536-22c65f834433',
  otherAlbum: '1b022e01-4da6-387b-8658-8678046e4cef',
  /** An artist whose albums Lidarr is still getting. */
  processingArtist: '8bfac288-ccc5-448d-9573-c33ea2aa5c30',
  processingAlbum: '6e335887-60ba-38f0-95af-fae7774336bf',
} as const;

export interface MusicFixtures {
  artist: Media;
  processingArtist: Media;
  albums: MusicAlbum[];
  /** One music request in each status, by status. */
  requests: Record<MediaRequestStatus, MediaRequest>;
}

/**
 * Music in the test database: two artists (Media of type music, tmdbId 0)
 * with ids on every server and in Lidarr, their albums, and a request for
 * an album in each status, all made long enough ago to count as old.
 * Saved without subscribers, as data already there would be.
 */
export async function seedMusicFixtures(): Promise<MusicFixtures> {
  assertTestDatabase('seed music fixtures');

  const manager = dataSource.manager;
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const ids = MUSIC_FIXTURE_IDS;

  const [artist, processingArtist] = await manager.save(
    [
      new Media({
        mediaType: MediaType.MUSIC,
        tmdbId: 0,
        foreignId: ids.artist,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        serviceId: 0,
        externalServiceId: 7,
        externalServiceSlug: ids.artist,
        ratingKey: '9001',
        jellyfinMediaId: 'jellyfin-artist',
        embyMediaId: 'emby-artist',
        mediaAddedAt: longAgo,
      }),
      new Media({
        mediaType: MediaType.MUSIC,
        tmdbId: 0,
        foreignId: ids.processingArtist,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 8,
        externalServiceSlug: ids.processingArtist,
      }),
    ],
    { listeners: false }
  );

  const albums = await manager.save(
    [
      new MusicAlbum({
        mediaId: artist.id,
        mbId: ids.album,
        title: 'Hail to the Thief',
        primaryType: 'Album',
        secondaryTypes: [],
        releaseDate: '2003-06-09',
        status: MediaStatus.AVAILABLE,
        lidarrAlbumId: 70,
        trackCount: 14,
        trackFileCount: 14,
        ratingKey: '9002',
        jellyfinItemId: 'jellyfin-album',
        embyItemId: 'emby-album',
        folder: 'Hail to the Thief (2003)',
        mediaAddedAt: longAgo,
      }),
      new MusicAlbum({
        mediaId: artist.id,
        mbId: ids.otherAlbum,
        title: 'OK Computer',
        primaryType: 'Album',
        secondaryTypes: [],
        releaseDate: '1997-05-21',
        status: MediaStatus.PROCESSING,
        lidarrAlbumId: 71,
        trackCount: 12,
        trackFileCount: 3,
      }),
      new MusicAlbum({
        mediaId: artist.id,
        mbId: null,
        title: 'A Bootleg Nobody Matched',
        secondaryTypes: ['Live'],
        status: MediaStatus.AVAILABLE,
        ratingKey: '9003',
      }),
      new MusicAlbum({
        mediaId: processingArtist.id,
        mbId: ids.processingAlbum,
        title: 'In Rainbows',
        primaryType: 'Album',
        secondaryTypes: [],
        releaseDate: '2007-10-10',
        status: MediaStatus.PROCESSING,
        lidarrAlbumId: 80,
      }),
    ],
    { listeners: false }
  );

  const requester = await getRepository(User).findOneByOrFail({ id: 2 });
  const statuses = [
    MediaRequestStatus.PENDING,
    MediaRequestStatus.APPROVED,
    MediaRequestStatus.DECLINED,
    MediaRequestStatus.FAILED,
    MediaRequestStatus.COMPLETED,
  ];
  const requests = {} as Record<MediaRequestStatus, MediaRequest>;
  for (const status of statuses) {
    const request = await manager.save(
      new MediaRequest({
        type: MediaType.MUSIC,
        status,
        media: artist,
        requestedBy: requester,
        is4k: false,
        serverId: 0,
        profileId: 1,
        metadataProfileId: 1,
        rootFolder: '/music',
        albums: [
          new AlbumRequest({
            albumMbid: ids.otherAlbum,
            title: 'OK Computer',
            status,
          }),
        ],
      }),
      { listeners: false }
    );
    requests[status] = request;
  }

  // Old enough for every "waiting too long" check to look at.
  await manager
    .createQueryBuilder()
    .update(MediaRequest)
    .set({ createdAt: longAgo, updatedAt: longAgo })
    .where({ type: MediaType.MUSIC })
    .callListeners(false)
    .execute();
  await manager
    .createQueryBuilder()
    .update(Media)
    .set({ updatedAt: longAgo })
    .where({ mediaType: MediaType.MUSIC })
    .callListeners(false)
    .execute();

  return {
    artist: await manager.findOneByOrFail(Media, { id: artist.id }),
    processingArtist: await manager.findOneByOrFail(Media, {
      id: processingArtist.id,
    }),
    albums,
    requests,
  };
}
