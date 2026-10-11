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
import { Permission } from '@server/lib/permissions';
import requestRoutes from '@server/routes/request';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import { after, beforeEach, describe, it } from 'node:test';

// Saving a request fires the subscriber, which hydrates from TMDB to build its
// notification. The suite blocks outbound requests, so stub it.
const stubTmdb = () => {
  // The client assigns these as instance properties in its constructor, so the
  // prototype stub needs a setter that swallows that write — the same shape
  // the Sonarr scanner tests use.
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
    // 2, not 3: the failed-but-available request must not be matched by
    // crossing "available"'s media status with "pending"'s request status.
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
});
