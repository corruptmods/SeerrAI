import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { MediaRequestWatcher } from '@server/entity/MediaRequestWatcher';
import { User } from '@server/entity/User';
import { UserPushSubscription } from '@server/entity/UserPushSubscription';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import requestRoutes from '@server/routes/request';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import { after, beforeEach, describe, it } from 'node:test';

const stubTmdb = () => {
  const stub = (name: string, value: unknown) =>
    Object.defineProperty(TheMovieDb.prototype, name, {
      configurable: true,
      set() {},
      get() {
        return async () => value;
      },
    });

  stub('getMovie', { id: 1, title: 'Test Movie', release_date: '2026-01-01' });
  stub('getTvShow', {
    id: 1,
    name: 'Test Series',
    first_air_date: '2026-01-01',
    seasons: [],
  });
};

/**
 * Muting is separate from deleting: someone who turns off notifications for
 * their own request must keep the request.
 */
describe('request watch state', () => {
  setupTestDb();

  let server: Server;
  let port: number;
  let requester: User;
  let other: User;
  let actor: () => User;
  let currentActor: User;

  const call = <T>(method: string, path: string) =>
    new Promise<{ status: number; body: T }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path, method },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode ?? 0,
                body: raw ? JSON.parse(raw) : (undefined as T),
              });
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', reject);
      req.end();
    });

  const makeUser = async (name: string) => {
    await getRepository(User).save(
      new User({
        email: `${name}@test.local`,
        plexUsername: name,
        permissions: Permission.ADMIN,
        avatar: '',
      })
    );

    return getRepository(User).findOneOrFail({ where: { plexUsername: name } });
  };

  const makeRequest = async (user: User, tmdbId: number) => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
      })
    );

    return getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        requestedBy: user,
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        is4k: false,
      })
    );
  };

  beforeEach(async () => {
    stubTmdb();
    getSettings().notifications.agents.webpush.enabled = true;

    requester = await makeUser('watch-requester');
    other = await makeUser('watch-other');
    currentActor = requester;
    actor = () => currentActor;

    // A reachable notification channel, so the watch routes do not refuse.
    await getRepository(UserPushSubscription).save(
      new UserPushSubscription({
        user: requester,
        endpoint: 'https://push.test/1',
        p256dh: 'p',
        auth: 'a',
        userAgent: 'test',
      })
    );
    await getRepository(UserPushSubscription).save(
      new UserPushSubscription({
        user: other,
        endpoint: 'https://push.test/2',
        p256dh: 'p',
        auth: 'a',
        userAgent: 'test',
      })
    );

    if (!server) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { user: User }).user = actor();
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

      server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      port = (server.address() as { port: number }).port;
    }
  });

  after(() => {
    server?.close();
  });

  it('reports the requester as notified by default', async () => {
    const request = await makeRequest(requester, 60001);

    const { body } = await call<{ watching: boolean; isRequester: boolean }>(
      'GET',
      `/api/v1/request/${request.id}/watch`
    );

    assert.equal(body.isRequester, true);
    assert.equal(body.watching, true);
  });

  it('mutes and unmutes without touching the request', async () => {
    const request = await makeRequest(requester, 60002);

    const muted = await call<{ watching: boolean }>(
      'DELETE',
      `/api/v1/request/${request.id}/watch`
    );
    assert.equal(muted.body.watching, false);
    assert.equal(
      await getRepository(MediaRequest).countBy({ id: request.id }),
      1,
      'muting must not delete the request'
    );

    const after = await call<{ watching: boolean }>(
      'GET',
      `/api/v1/request/${request.id}/watch`
    );
    assert.equal(after.body.watching, false);

    const unmuted = await call<{ watching: boolean }>(
      'POST',
      `/api/v1/request/${request.id}/watch`
    );
    assert.equal(unmuted.body.watching, true);
    assert.equal(
      await getRepository(MediaRequest).countBy({ id: request.id }),
      1
    );
  });

  it('records another user as a watcher rather than muting', async () => {
    const request = await makeRequest(other, 60003);
    currentActor = requester;

    const watching = await call<{ watching: boolean; isRequester: boolean }>(
      'POST',
      `/api/v1/request/${request.id}/watch`
    );

    assert.equal(watching.body.watching, true);
    assert.equal(
      await getRepository(MediaRequestWatcher).countBy({
        requestId: request.id,
        userId: requester.id,
      }),
      1
    );

    const stopped = await call<{ watching: boolean }>(
      'DELETE',
      `/api/v1/request/${request.id}/watch`
    );
    assert.equal(stopped.body.watching, false);
    assert.equal(
      await getRepository(MediaRequestWatcher).countBy({
        requestId: request.id,
      }),
      0
    );
    assert.equal(
      await getRepository(MediaRequest).countBy({ id: request.id }),
      1,
      "unwatching someone else's request must not delete it"
    );
  });
});
