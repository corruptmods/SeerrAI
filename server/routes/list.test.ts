import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  MediaList,
  MediaListItem,
  MediaListMember,
} from '@server/entity/MediaList';
import { MediaRequest } from '@server/entity/MediaRequest';
import { MediaRequestWatcher } from '@server/entity/MediaRequestWatcher';
import { User } from '@server/entity/User';
import notificationManager from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import listRoutes from '@server/routes/list';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import { after, beforeEach, describe, it } from 'node:test';
import { In } from 'typeorm';

const stubTmdb = () => {
  // Assigned as instance properties in the constructor, so the prototype stub
  // needs a setter that swallows that write.
  const stub = (name: string, fn: (arg: never) => unknown) =>
    Object.defineProperty(TheMovieDb.prototype, name, {
      configurable: true,
      set() {},
      get() {
        return async (arg: never) => fn(arg);
      },
    });

  stub('getMovie', ({ movieId }: { movieId: number }) => ({
    id: movieId,
    title: `Movie ${movieId}`,
    poster_path: `/m${movieId}.jpg`,
    release_date: '2026-01-01',
  }));
  stub('getTvShow', ({ tvId }: { tvId: number }) => ({
    id: tvId,
    name: `Series ${tvId}`,
    poster_path: `/t${tvId}.jpg`,
    first_air_date: '2026-01-01',
    seasons: [
      { season_number: 0, episode_count: 3 },
      { season_number: 1, episode_count: 8 },
    ],
  }));
  stub('getCollection', ({ collectionId }: { collectionId: number }) => ({
    id: collectionId,
    name: 'Test Collection',
    parts: [{ id: 8001 }, { id: 8002 }, { id: 8003 }],
  }));
  stub('searchMulti', ({ query }: { query: string }) => ({
    results: [
      {
        id: 7001,
        media_type: 'movie',
        title: query,
        release_date: '1999-03-31',
        poster_path: '/a.jpg',
        popularity: 10,
      },
      {
        id: 7002,
        media_type: 'collection',
        title: `${query} Collection`,
        poster_path: '/c.jpg',
      },
      { id: 7003, media_type: 'person', name: 'Someone' },
    ],
  }));
};

describe('watch lists', () => {
  setupTestDb();

  let server: Server;
  let port: number;
  let owner: User;
  let member: User;
  let outsider: User;
  let notified: string[];
  // Who the requests come from; the owner unless a test says otherwise.
  let actingAs: User | undefined;

  const call = <T>(method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; body: T }>((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload
              ? { 'Content-Length': Buffer.byteLength(payload) }
              : {}),
          },
        },
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

      if (payload) {
        req.write(payload);
      }

      req.end();
    });

  const makeUser = async (name: string, permissions: number) => {
    await getRepository(User).save(
      new User({
        email: `${name}@test.local`,
        plexUsername: name,
        permissions,
        avatar: '',
      })
    );

    return getRepository(User).findOneOrFail({
      where: { plexUsername: name },
    });
  };

  beforeEach(async () => {
    stubTmdb();
    notified = [];
    actingAs = undefined;
    Object.defineProperty(notificationManager, 'sendNotification', {
      configurable: true,
      value: (_type: number, payload: { notifyUser?: User }) => {
        if (payload.notifyUser) {
          notified.push(payload.notifyUser.plexUsername ?? '');
        }
      },
    });

    owner = await makeUser('list-owner', Permission.ADMIN);
    member = await makeUser('list-member', Permission.REQUEST);
    outsider = await makeUser('list-outsider', Permission.REQUEST);

    if (!server) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { user: User }).user = actingAs ?? owner;
        next();
      });
      app.use('/api/v1/list', listRoutes);
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

  const createList = async (name = 'Test List') => {
    const { body } = await call<{ id: number }>('POST', '/api/v1/list', {
      name,
    });

    return body.id;
  };

  describe('leaving a shared list', () => {
    it('lets someone it was shared with leave it', async () => {
      const id = await createList();
      await call('PUT', `/api/v1/list/${id}`, { memberIds: [member.id] });

      actingAs = member;
      const left = await call('DELETE', `/api/v1/list/${id}/membership`);
      assert.equal(left.status, 204);
      assert.equal(
        await getRepository(MediaListMember).countBy({ listId: id }),
        0
      );
      assert.equal((await call('GET', `/api/v1/list/${id}`)).status, 404);
    });

    it('does not let the owner leave, or a stranger touch it', async () => {
      const id = await createList();
      await call('PUT', `/api/v1/list/${id}`, { memberIds: [member.id] });

      const own = await call('DELETE', `/api/v1/list/${id}/membership`);
      assert.equal(own.status, 400);

      actingAs = outsider;
      const stranger = await call('DELETE', `/api/v1/list/${id}/membership`);
      assert.equal(stranger.status, 404);
      assert.equal(
        await getRepository(MediaListMember).countBy({ listId: id }),
        1
      );
    });
  });

  describe('sharing', () => {
    it('shares with a user and notifies only the new member', async () => {
      const id = await createList();

      const shared = await call('PUT', `/api/v1/list/${id}`, {
        memberIds: [member.id],
      });

      assert.equal(shared.status, 200);
      assert.deepEqual(notified, ['list-member']);
      assert.equal(
        await getRepository(MediaListMember).countBy({ listId: id }),
        1
      );
    });

    it('does not re-notify members who were already on the list', async () => {
      const id = await createList();
      await call('PUT', `/api/v1/list/${id}`, { memberIds: [member.id] });

      notified = [];
      const again = await call('PUT', `/api/v1/list/${id}`, {
        memberIds: [member.id],
      });

      assert.equal(again.status, 200);
      assert.deepEqual(notified, []);
    });

    it('keeps the list intact when sharing changes', async () => {
      const id = await createList();
      await call('POST', `/api/v1/list/${id}/item`, {
        tmdbId: 550,
        mediaType: 'movie',
      });

      await call('PUT', `/api/v1/list/${id}`, { memberIds: [member.id] });
      await call('PUT', `/api/v1/list/${id}`, { memberIds: [] });

      // Saving the list used to cascade its stale members array and fail.
      assert.equal(
        await getRepository(MediaListItem).countBy({ listId: id }),
        1
      );
      assert.equal(
        await getRepository(MediaListMember).countBy({ listId: id }),
        0
      );
    });

    it('renames without disturbing members', async () => {
      const id = await createList('Before');
      await call('PUT', `/api/v1/list/${id}`, { memberIds: [member.id] });

      const renamed = await call('PUT', `/api/v1/list/${id}`, {
        name: 'After',
        memberIds: [member.id],
      });

      assert.equal(renamed.status, 200);
      const list = await getRepository(MediaList).findOneOrFail({
        where: { id },
      });
      assert.equal(list.name, 'After');
      assert.equal(
        await getRepository(MediaListMember).countBy({ listId: id }),
        1
      );
    });
  });

  describe('markers', () => {
    it('reports only this user lists and unmuted notifications', async () => {
      const mineId = await createList('Mine');
      await call('POST', `/api/v1/list/${mineId}/item`, {
        tmdbId: 11,
        mediaType: 'movie',
      });

      // Another user's list must not appear.
      const theirs = await getRepository(MediaList).save(
        new MediaList({ name: 'Theirs', ownerId: outsider.id })
      );
      await getRepository(MediaListItem).save(
        new MediaListItem({
          listId: theirs.id,
          tmdbId: 99,
          mediaType: 'movie',
        })
      );

      const live = await getRepository(Media).save(
        new Media({
          tmdbId: 22,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
        })
      );
      await getRepository(MediaRequest).save(
        new MediaRequest({
          media: live,
          requestedBy: owner,
          type: MediaType.MOVIE,
          status: MediaRequestStatus.APPROVED,
          is4k: false,
        })
      );

      const muted = await getRepository(Media).save(
        new Media({
          tmdbId: 33,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
        })
      );
      await getRepository(MediaRequest).save(
        new MediaRequest({
          media: muted,
          requestedBy: owner,
          type: MediaType.MOVIE,
          status: MediaRequestStatus.APPROVED,
          is4k: false,
          requesterMuted: true,
        })
      );

      const watchedMedia = await getRepository(Media).save(
        new Media({
          tmdbId: 44,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
        })
      );
      const theirRequest = await getRepository(MediaRequest).save(
        new MediaRequest({
          media: watchedMedia,
          requestedBy: outsider,
          type: MediaType.MOVIE,
          status: MediaRequestStatus.APPROVED,
          is4k: false,
        })
      );
      await getRepository(MediaRequestWatcher).save(
        new MediaRequestWatcher({
          requestId: theirRequest.id,
          userId: owner.id,
        })
      );

      const { body } = await call<{
        lists: { tmdbId: number }[];
        notify: { tmdbId: number }[];
      }>('GET', '/api/v1/list/markers');

      assert.deepEqual(
        body.lists.map((entry) => entry.tmdbId),
        [11]
      );
      assert.deepEqual(
        body.notify.map((entry) => entry.tmdbId).sort((a, b) => a - b),
        [22, 44]
      );
    });
  });

  describe('import', () => {
    it('parses a messy list and drops headings and duplicates', async () => {
      const { body } = await call<{ results: { raw: string }[] }>(
        'POST',
        '/api/v1/list/import/search',
        {
          text: [
            'Movies:',
            '- The Matrix (1999)',
            '• Practical Magic',
            '[x] Person of Interest',
            'Insidious — with Jordan',
            '- The Matrix (1999)',
          ].join('\n'),
        }
      );

      assert.equal(body.results.length, 4);
    });

    it('offers a collection first on set wording but keeps other matches', async () => {
      const { body } = await call<{
        results: {
          collectionHint?: boolean;
          candidates: { mediaType: string; partCount?: number }[];
        }[];
      }>('POST', '/api/v1/list/import/search', {
        text: 'Pitch Perfect series',
      });

      const line = body.results[0];
      assert.equal(line.collectionHint, true);
      assert.equal(line.candidates[0].mediaType, 'collection');
      assert.equal(line.candidates[0].partCount, 3);
      // The individual film must remain selectable.
      assert.ok(line.candidates.some((c) => c.mediaType === 'movie'));
      // People are not importable.
      assert.ok(!line.candidates.some((c) => c.mediaType === 'person'));
    });

    it('expands a collection into its films and is idempotent', async () => {
      const id = await createList();

      const first = await call<{ added: number; skipped: number }>(
        'POST',
        `/api/v1/list/${id}/import`,
        { items: [{ tmdbId: 500, mediaType: 'collection' }], request: false }
      );

      assert.equal(first.body.added, 3);

      const stored = await getRepository(MediaListItem).findBy({ listId: id });
      assert.deepEqual(
        stored.map((item) => item.tmdbId).sort((a, b) => a - b),
        [8001, 8002, 8003]
      );
      assert.ok(stored.every((item) => item.mediaType === 'movie'));

      const again = await call<{ added: number; skipped: number }>(
        'POST',
        `/api/v1/list/${id}/import`,
        { items: [{ tmdbId: 500, mediaType: 'collection' }], request: false }
      );

      assert.equal(again.body.added, 0);
      assert.equal(again.body.skipped, 3);
    });

    it('keeps only real TMDB poster paths from an import', async () => {
      const id = await createList();

      await call('POST', `/api/v1/list/${id}/import`, {
        items: [
          { tmdbId: 710, mediaType: 'movie', posterPath: '/aB3_x-9.jpg' },
          {
            tmdbId: 711,
            mediaType: 'movie',
            posterPath: '/../../api/v1/user/1',
          },
          {
            tmdbId: 712,
            mediaType: 'movie',
            posterPath: '/x.jpg?https://elsewhere.test/',
          },
        ],
        request: false,
      });

      const stored = await getRepository(MediaListItem).findBy({ listId: id });
      const poster = (tmdbId: number) =>
        stored.find((item) => item.tmdbId === tmdbId)?.posterPath;
      assert.equal(poster(710), '/aB3_x-9.jpg');
      // Not stored as given; filled in later from TMDB itself.
      assert.notEqual(poster(711), '/../../api/v1/user/1');
      assert.notEqual(poster(712), '/x.jpg?https://elsewhere.test/');
    });

    it('de-duplicates titles listed twice in one import', async () => {
      const id = await createList();

      const { body } = await call<{ added: number; skipped: number }>(
        'POST',
        `/api/v1/list/${id}/import`,
        {
          items: [
            { tmdbId: 700, mediaType: 'movie' },
            { tmdbId: 700, mediaType: 'movie' },
            { tmdbId: 701, mediaType: 'movie' },
          ],
          request: false,
        }
      );

      assert.equal(body.added, 2);
      assert.equal(body.skipped, 1);
      assert.equal(
        await getRepository(MediaListItem).countBy({ listId: id }),
        2
      );
    });

    it('treats a movie and a series with the same id as different titles', async () => {
      const id = await createList();

      const { body } = await call<{ added: number }>(
        'POST',
        `/api/v1/list/${id}/import`,
        {
          items: [
            { tmdbId: 900, mediaType: 'movie' },
            { tmdbId: 900, mediaType: 'tv' },
          ],
          request: false,
        }
      );

      assert.equal(body.added, 2);
    });

    it('keeps the poster the client already matched', async () => {
      const id = await createList();

      await call('POST', `/api/v1/list/${id}/import`, {
        items: [
          { tmdbId: 950, mediaType: 'movie', posterPath: '/matched.jpg' },
        ],
        request: false,
      });

      const [item] = await getRepository(MediaListItem).findBy({ listId: id });
      assert.equal(item.posterPath, '/matched.jpg');
    });

    it('re-requests media that was deleted from the library', async () => {
      // A title removed in the past is missing, not handled. Its old request
      // is history and must not block a new one.
      const id = await createList();
      const removed = await getRepository(Media).save(
        new Media({
          tmdbId: 4242,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.DELETED,
        })
      );
      await getRepository(MediaRequest).save(
        new MediaRequest({
          media: removed,
          requestedBy: owner,
          type: MediaType.MOVIE,
          status: MediaRequestStatus.COMPLETED,
          is4k: false,
        })
      );

      const { body } = await call<{ added: number; requested: number }>(
        'POST',
        `/api/v1/list/${id}/import`,
        {
          items: [{ tmdbId: 4242, mediaType: 'movie' }],
          request: true,
        }
      );

      assert.equal(body.added, 1);
      assert.equal(
        body.requested,
        1,
        'deleted media should be requested again'
      );
    });

    it('does not re-request something already on its way', async () => {
      const id = await createList();
      const pending = await getRepository(Media).save(
        new Media({
          tmdbId: 4343,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
        })
      );
      await getRepository(MediaRequest).save(
        new MediaRequest({
          media: pending,
          requestedBy: owner,
          type: MediaType.MOVIE,
          status: MediaRequestStatus.APPROVED,
          is4k: false,
        })
      );

      const { body } = await call<{ requested: number }>(
        'POST',
        `/api/v1/list/${id}/import`,
        { items: [{ tmdbId: 4343, mediaType: 'movie' }], request: true }
      );

      assert.equal(body.requested, 0);
    });

    it('requests at most 20 titles from one import, and adds them all', async () => {
      const id = await createList();
      const items = Array.from({ length: 25 }, (_, i) => ({
        tmdbId: 6100 + i,
        mediaType: 'movie',
      }));

      const { body } = await call<{
        added: number;
        requested: number;
        requestFailed: number;
        notRequested: number;
      }>('POST', `/api/v1/list/${id}/import`, { items, request: true });

      assert.equal(body.added, 25);
      assert.equal(body.requested + body.requestFailed, 20);
      assert.equal(body.notRequested, 5);
      assert.equal(
        await getRepository(MediaRequest).count({
          where: { media: { tmdbId: In(items.map((item) => item.tmdbId)) } },
        }),
        body.requested
      );
    });

    it('reports nothing left unrequested when not asked to request', async () => {
      const id = await createList();
      const { body } = await call<{ notRequested: number }>(
        'POST',
        `/api/v1/list/${id}/import`,
        {
          items: Array.from({ length: 25 }, (_, i) => ({
            tmdbId: 6200 + i,
            mediaType: 'movie',
          })),
          request: false,
        }
      );

      assert.equal(body.notRequested, 0);
    });

    it('refuses an import for a list the user cannot see', async () => {
      const theirs = await getRepository(MediaList).save(
        new MediaList({ name: 'Theirs', ownerId: outsider.id })
      );

      const { status } = await call(
        'POST',
        `/api/v1/list/${theirs.id}/import`,
        {
          items: [{ tmdbId: 1, mediaType: 'movie' }],
        }
      );

      assert.equal(status, 404);
    });
  });

  describe('series progress', () => {
    it('is reachable through the API', async () => {
      // Mounts the router directly, so this covers the route and its access
      // check. Its OpenAPI declaration is covered by the spec tests, which
      // put the real validator in front.
      const id = await createList();

      const { status, body } = await call<Record<string, unknown>>(
        'GET',
        `/api/v1/list/${id}/progress`
      );

      assert.equal(status, 200);
      assert.deepEqual(body, {}, 'no Tautulli configured, so no progress');
    });

    it('is not available for a list the user cannot see', async () => {
      const theirs = await getRepository(MediaList).save(
        new MediaList({ name: 'Theirs', ownerId: outsider.id })
      );

      const { status } = await call(
        'GET',
        `/api/v1/list/${theirs.id}/progress`
      );

      assert.equal(status, 404);
    });
  });

  describe('overview artwork', () => {
    it('stores poster paths so later loads need no TMDB call', async () => {
      const id = await createList();

      for (let i = 1; i <= 4; i++) {
        await getRepository(MediaListItem).save(
          new MediaListItem({ listId: id, tmdbId: i, mediaType: 'movie' })
        );
      }

      const first = await call<{ previews: unknown[] }[]>(
        'GET',
        '/api/v1/list'
      );
      assert.equal(first.body[0].previews.length, 4);

      const stored = await getRepository(MediaListItem).findBy({ listId: id });
      assert.ok(
        stored.every((item) => !!item.posterPath),
        'every item should have its poster stored after the first load'
      );
    });
  });
});
