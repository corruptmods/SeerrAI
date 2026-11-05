import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import AlbumRequest from '@server/entity/AlbumRequest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import SongRequest from '@server/entity/SongRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import type { LidarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import requestRoutes from '@server/routes/request';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

// Saving a request fires the subscriber, which loads TMDB data for its
// notification. The suite blocks outbound requests, so stub it.
const stubTmdb = () => {
  // The client assigns these as instance properties in its constructor, so the
  // prototype stub needs a setter that swallows that write (as in the Sonarr
  // scanner tests).
  const stub = (name: string, value: unknown) =>
    Object.defineProperty(TheMovieDb.prototype, name, {
      configurable: true,
      set() {},
      get() {
        return async () => value;
      },
    });

  stub('getMovie', {
    id: 1,
    title: 'Test Movie',
    release_date: '2026-01-01',
  });
  stub('getTvShow', {
    id: 1,
    name: 'Test Series',
    first_air_date: '2026-01-01',
    seasons: [],
  });
};

describe('request list filtering', () => {
  setupTestDb();

  let server: Server;
  let port: number;
  let actor: User;

  const listen = async (currentUser: () => User) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: User }).user = currentUser();
      next();
    });
    app.use('/api/v1/request', requestRoutes);
    app.use(
      (
        err: { status?: number; message: string },
        _req: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: express.NextFunction
      ) => res.status(err.status ?? 500).json({ message: err.message })
    );

    return new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
  };

  const query = (search: string) =>
    new Promise<{ results: { id: number }[] }>((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port,
            path: `/api/v1/request?take=50&${search}`,
          },
          (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(e);
              }
            });
          }
        )
        .on('error', reject);
    });

  const count = async (search: string) => (await query(search)).results.length;

  beforeEach(async () => {
    stubTmdb();

    const userRepository = getRepository(User);

    await userRepository.save(
      new User({
        email: 'filter-actor@test.local',
        plexUsername: 'filter-actor',
        permissions: Permission.ADMIN,
        avatar: '',
      })
    );
    actor = await userRepository.findOneOrFail({
      where: { plexUsername: 'filter-actor' },
    });

    await userRepository.save(
      new User({
        email: 'filter-other@test.local',
        plexUsername: 'filter-other',
        permissions: Permission.REQUEST,
        avatar: '',
      })
    );
    const other = await userRepository.findOneOrFail({
      where: { plexUsername: 'filter-other' },
    });

    let tmdbId = 90000;
    const add = async (
      requestedBy: User,
      type: MediaType,
      requestStatus: MediaRequestStatus,
      mediaStatus: MediaStatus
    ) => {
      const media = await getRepository(Media).save(
        new Media({ tmdbId: tmdbId++, mediaType: type, status: mediaStatus })
      );

      await getRepository(MediaRequest).save(
        new MediaRequest({
          media,
          requestedBy,
          type,
          status: requestStatus,
          is4k: false,
        })
      );
    };

    await add(
      actor,
      MediaType.MOVIE,
      MediaRequestStatus.PENDING,
      MediaStatus.PENDING
    );
    await add(
      actor,
      MediaType.MOVIE,
      MediaRequestStatus.FAILED,
      MediaStatus.PROCESSING
    );
    await add(
      other,
      MediaType.TV,
      MediaRequestStatus.COMPLETED,
      MediaStatus.AVAILABLE
    );
    await add(
      other,
      MediaType.TV,
      MediaRequestStatus.COMPLETED,
      MediaStatus.PROCESSING
    );
    // The case a naive implementation gets wrong.
    await add(
      actor,
      MediaType.MOVIE,
      MediaRequestStatus.FAILED,
      MediaStatus.AVAILABLE
    );

    if (!server) {
      server = await listen(() => actor);
      port = (server.address() as { port: number }).port;
    }
  });

  after(() => {
    server?.close();
  });

  it('returns everything with no filter', async () => {
    assert.equal(await count('filter=all'), 5);
  });

  it('filters by a single status', async () => {
    assert.equal(await count('filter=pending'), 1);
    assert.equal(await count('filter=failed'), 2);
  });

  it('unions several statuses', async () => {
    assert.equal(await count('filter=pending,failed'), 3);
  });

  it('treats available as completed AND available', async () => {
    assert.equal(await count('filter=available'), 1);
  });

  it('keeps each filter its own condition pair', async () => {
    // 2, not 3: the failed-but-available request must not match by crossing
    // "available"'s media status with "pending"'s request status.
    assert.equal(await count('filter=available,pending'), 2);
  });

  it('filters by media type, and both is the same as neither', async () => {
    assert.equal(await count('filter=all&mediaType=movie'), 3);
    assert.equal(await count('filter=all&mediaType=movie,tv'), 5);
  });

  it('filters by one or several users', async () => {
    const others = await getRepository(User).findOneOrFail({
      where: { plexUsername: 'filter-other' },
    });

    assert.equal(await count(`filter=all&requestedBy=${others.id}`), 2);
    assert.equal(
      await count(`filter=all&requestedBy=${actor.id},${others.id}`),
      5
    );
  });

  describe('by words', () => {
    let searched: string[];

    beforeEach(() => {
      searched = [];
      // TMDB's matches for the words: a film, a series, and an id that's a
      // series here but a film there.
      Object.defineProperty(TheMovieDb.prototype, 'searchMulti', {
        configurable: true,
        set() {},
        get() {
          return async ({
            query,
            page = 1,
          }: {
            query: string;
            page?: number;
          }) => {
            searched.push(`${query}:${page}`);
            return {
              page,
              total_pages: 1,
              total_results: 3,
              results:
                query === 'static'
                  ? [
                      { id: 90000, media_type: 'movie' },
                      { id: 90002, media_type: 'tv' },
                      { id: 90003, media_type: 'movie' },
                    ]
                  : [],
            };
          };
        },
      });
    });

    afterEach(() => {
      delete (TheMovieDb.prototype as unknown as Record<string, unknown>)
        .searchMulti;
      getSettings().lidarr = [];
    });

    it('finds films and series as TMDB finds them', async () => {
      assert.equal(await count('filter=all&search=static'), 2);
      assert.deepEqual(searched, ['static:1']);
      assert.equal(await count('filter=all&search=nothing%20here'), 0);
    });

    it('finds music by its artist, album or song', async () => {
      getSettings().lidarr = [{ id: 0, isDefault: true } as LidarrSettings];
      const music = async (artist: string, album?: string, song?: string) => {
        const media = await getRepository(Media).save(
          new Media({
            tmdbId: 0,
            mediaType: MediaType.MUSIC,
            foreignId: `artist-${artist}`,
            foreignTitle: artist,
            status: MediaStatus.PENDING,
          })
        );
        const request = await getRepository(MediaRequest).save(
          new MediaRequest({
            media,
            requestedBy: actor,
            type: MediaType.MUSIC,
            status: MediaRequestStatus.COMPLETED,
            is4k: false,
          })
        );
        if (album) {
          await getRepository(AlbumRequest).save(
            new AlbumRequest({
              request,
              albumMbid: `album-${album}`,
              title: album,
            })
          );
        }
        if (song) {
          await getRepository(SongRequest).save(
            new SongRequest({
              request,
              recordingMbid: `rec-${song}`,
              title: song,
              version: null,
              albumMbid: 'a',
              albumTitle: 'A',
              releaseGroups: [],
              status: MediaRequestStatus.COMPLETED,
            })
          );
        }
        return request.id;
      };
      const garden = await music('Glasswing', 'Static Garden');
      const lantern = await music('Harbour Lights', undefined, 'Lantern Song');
      const ids = async (words: string) =>
        (await query(`filter=all&search=${encodeURIComponent(words)}`)).results
          .map((r) => r.id)
          .sort((a, b) => a - b);
      assert.deepEqual(await ids('glass'), [garden]);
      assert.deepEqual(await ids('LANTERN'), [lantern]);
      // The album's name, plus TMDB's films and series.
      assert.equal((await ids('static')).length, 3);
      assert.ok((await ids('static')).includes(garden));
      // A wildcard is a literal character.
      assert.deepEqual(await ids('%'), []);
    });
  });
});
