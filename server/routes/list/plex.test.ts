import type {
  PlexListDetail,
  PlexListEntry,
  PlexListSummary,
  PlexTitleIds,
} from '@server/api/plexLists';
import PlexListsAPI, { PlexListsError } from '@server/api/plexLists';
import TheMovieDb from '@server/api/themoviedb';
import { getRepository } from '@server/datasource';
import { MediaList, MediaListItem } from '@server/entity/MediaList';
import {
  MediaRequest,
  QuotaRestrictedError,
} from '@server/entity/MediaRequest';
import { PlexListFollow } from '@server/entity/PlexListFollow';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { plexListSync } from '@server/lib/plexLists';
import listRoutes from '@server/routes/list';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import { after, beforeEach, describe, it, mock } from 'node:test';

/*
 * Plex Lists with Plex itself faked: a person's lists and their titles live
 * here, and the client's calls read and change them. Plex ids are "p<n>"; a
 * film's TMDB id is n, a series' n + 5000 (ids from 50 up are series), and
 * "s<n>" is a season of series p<n>.
 */

interface FakeList {
  summary: PlexListSummary;
  ranked: boolean;
  entries: PlexListEntry[];
}

let plexLists: FakeList[] = [];
let plexFails: PlexListsError | undefined;
let edits: { listId: string; change: string; plexId: string }[] = [];
let created: { title: string; ranked: boolean }[] = [];

const entry = (plexId: string): PlexListEntry => ({
  plexId,
  title: `Title ${plexId}`,
  kind: plexId.startsWith('s') ? 'part' : 'movie',
});

const fakeList = (
  id: string,
  slug: string,
  plexIds: string[],
  ranked = false
): FakeList => ({
  summary: {
    id,
    owner: 'Garden',
    slug,
    title: `List ${slug}`,
    itemCount: plexIds.length,
    privacy: 'PRIVATE',
  },
  ranked,
  entries: plexIds.map(entry),
});

const idsOf = (plexId: string): PlexTitleIds | null => {
  const series = plexId.startsWith('s');
  const n = Number(plexId.slice(1));
  if (!Number.isFinite(n) || n === 0) return null;
  return series || n >= 50
    ? { tmdbId: n + 5000, mediaType: 'tv', tvdbId: n + 9000 }
    : { tmdbId: n, mediaType: 'movie' };
};

const fakePlex = () => {
  const failing = <T>(value: () => T) => {
    if (plexFails) throw plexFails;
    return value();
  };
  mock.method(PlexListsAPI.prototype, 'getMyLists', async () =>
    failing(() => plexLists.map((list) => ({ ...list.summary })))
  );
  mock.method(
    PlexListsAPI.prototype,
    'getList',
    async (owner: string, slug: string): Promise<PlexListDetail> =>
      failing(() => {
        const list = plexLists.find(
          (l) => l.summary.owner === owner && l.summary.slug === slug
        );
        if (!list) throw new PlexListsError('missing', 'No such list.');
        return {
          title: list.summary.title,
          ranked: list.ranked,
          privacy: 'PRIVATE',
          entries: list.entries.map((e) => ({ ...e })),
          truncated: false,
        };
      })
  );
  mock.method(
    PlexListsAPI.prototype,
    'editList',
    async (listId: string, change: 'add' | 'remove', plexId: string) =>
      failing(() => {
        edits.push({ listId, change, plexId });
        const list = plexLists.find((l) => l.summary.id === listId);
        if (!list) throw new PlexListsError('missing', 'No such list.');
        list.entries =
          change === 'add'
            ? [...list.entries, entry(plexId)]
            : list.entries.filter((e) => e.plexId !== plexId);
      })
  );
  mock.method(PlexListsAPI.prototype, 'idsOf', async (plexId: string) =>
    failing(() => idsOf(plexId))
  );
  mock.method(
    PlexListsAPI.prototype,
    'plexIdOf',
    async (tmdbId: number, mediaType: 'movie' | 'tv') =>
      failing(() => {
        if (tmdbId === 404) return null;
        return mediaType === 'movie' ? `p${tmdbId}` : `p${tmdbId - 5000}`;
      })
  );
  mock.method(
    PlexListsAPI.prototype,
    'createList',
    async (title: string, ranked: boolean) =>
      failing(() => {
        created.push({ title, ranked });
        const slug = `new${created.length}-${title.toLowerCase()}`;
        plexLists.push({
          ...fakeList(`new-${created.length}`, slug, [], ranked),
          summary: {
            id: `new-${created.length}`,
            owner: 'Garden',
            slug,
            title,
            itemCount: 0,
            privacy: 'PRIVATE',
          },
        });
        return { owner: 'Garden', slug };
      })
  );
};

const stubTmdb = () => {
  Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
    configurable: true,
    set() {},
    get() {
      return async ({ tvId }: { tvId: number }) => ({
        id: tvId,
        name: `Series ${tvId}`,
        seasons: [
          { season_number: 0, episode_count: 2 },
          { season_number: 1, episode_count: 8 },
        ],
      });
    },
  });
};

describe('Plex Lists', () => {
  setupTestDb();

  let server: Server;
  let port: number;
  let person: User;
  let requests: {
    mediaId: number;
    mediaType: string;
    isAutoRequest?: boolean;
    userId: number;
  }[];

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
      if (payload) req.write(payload);
      req.end();
    });

  const makeUser = async (
    name: string,
    permissions: number,
    plexToken: string | null
  ) => {
    await getRepository(User).save(
      new User({
        email: `${name}@test.local`,
        plexUsername: name,
        permissions,
        avatar: '',
        // Each its own Plex account, so no test reads another's cache.
        plexToken: plexToken && `${plexToken}-${name}`,
      })
    );
    return getRepository(User).findOneOrFail({
      where: { plexUsername: name },
    });
  };

  beforeEach(async () => {
    mock.restoreAll();
    fakePlex();
    stubTmdb();
    plexFails = undefined;
    edits = [];
    created = [];
    requests = [];
    plexLists = [
      fakeList('list-a', 'a1-glasswing', ['p1', 'p2', 'p60']),
      fakeList('list-b', 'b2-static-garden', ['p3', 's70', 'p0', 'p1'], true),
    ];
    mock.method(
      MediaRequest,
      'request',
      async (
        body: { mediaId: number; mediaType: string },
        user: User,
        options: { isAutoRequest?: boolean } = {}
      ) => {
        requests.push({
          mediaId: body.mediaId,
          mediaType: body.mediaType,
          isAutoRequest: options.isAutoRequest,
          userId: user.id,
        });
        return { id: requests.length };
      }
    );

    // A new person each test: the lists cache is per person.
    person = await makeUser(
      `plex-${Math.random().toString(36).slice(2)}`,
      Permission.REQUEST | Permission.AUTO_REQUEST,
      'plex-token'
    );

    if (!server) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { user: User }).user = person;
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
    mock.restoreAll();
    server?.close();
  });

  /** A check, as if the last one was long enough ago. */
  const checkLists = async () => {
    await getRepository(PlexListFollow)
      .createQueryBuilder()
      .update()
      .set({ checkedAt: null })
      .execute();
    await plexListSync.run();
  };

  it('has no section for someone without a Plex sign-in', async () => {
    person = await makeUser('no-plex', Permission.REQUEST, null);
    const { status, body } = await call<{ available: boolean; lists: [] }>(
      'GET',
      '/api/v1/list/plex'
    );
    assert.equal(status, 200);
    assert.deepEqual(body, { available: false, lists: [] });
    assert.equal(
      (await call('GET', '/api/v1/list/plex/Garden/a1-glasswing')).status,
      404
    );
  });

  it("lists the person's Plex lists", async () => {
    const { status, body } = await call<{
      available: boolean;
      canAutoRequest: boolean;
      lists: {
        id: string;
        slug: string;
        itemCount: number;
        autoRequest: boolean;
      }[];
    }>('GET', '/api/v1/list/plex');
    assert.equal(status, 200);
    assert.equal(body.available, true);
    assert.equal(body.canAutoRequest, true);
    assert.deepEqual(
      body.lists.map((l) => [l.id, l.slug, l.itemCount, l.autoRequest]),
      [
        ['list-a', 'a1-glasswing', 3, false],
        ['list-b', 'b2-static-garden', 4, false],
      ]
    );
  });

  it('shows a list in order, matched to TMDB, a season as its series', async () => {
    const { status, body } = await call<{
      ranked: boolean;
      items: { plexId: string; tmdbId?: number; mediaType?: string }[];
    }>('GET', '/api/v1/list/plex/Garden/b2-static-garden');
    assert.equal(status, 200);
    assert.equal(body.ranked, true);
    assert.deepEqual(
      body.items.map((i) => [i.plexId, i.tmdbId, i.mediaType]),
      [
        ['p3', 3, 'movie'],
        ['s70', 5070, 'tv'],
        // Plex couldn't say what it is.
        ['p0', undefined, undefined],
        ['p1', 1, 'movie'],
      ]
    );
  });

  it("refuses a list that isn't the person's", async () => {
    const { status } = await call(
      'GET',
      '/api/v1/list/plex/Someone/x1-lantern-song'
    );
    assert.equal(status, 404);
  });

  it('says plainly when Plex refuses the sign-in or changed', async () => {
    plexFails = new PlexListsError('auth', 'refused');
    let reply = await call<{ message: string }>('GET', '/api/v1/list/plex');
    assert.equal(reply.status, 401);
    assert.match(reply.body.message, /sign/i);

    plexFails = new PlexListsError('changed', 'odd');
    reply = await call<{ message: string }>('GET', '/api/v1/list/plex');
    assert.equal(reply.status, 502);
    assert.match(reply.body.message, /changed/);
  });

  it('copies a list into a Seerr AI list in its order', async () => {
    const { status, body } = await call<{
      id: number;
      added: number;
      unmatched: number;
    }>('POST', '/api/v1/list/plex/Garden/b2-static-garden/copy');
    assert.equal(status, 201);
    assert.equal(body.added, 3);
    assert.equal(body.unmatched, 1);

    const list = await getRepository(MediaList).findOneOrFail({
      where: { id: body.id },
    });
    assert.equal(list.name, 'List b2-static-garden');
    assert.equal(list.ownerId, person.id);
    // Newest first, as lists show: Plex's first title first.
    const items = await getRepository(MediaListItem).find({
      where: { listId: body.id },
      order: { createdAt: 'DESC' },
    });
    assert.deepEqual(
      items.map((i) => [i.tmdbId, i.mediaType]),
      [
        [3, 'movie'],
        [5070, 'tv'],
        [1, 'movie'],
      ]
    );
    // Copying requests nothing.
    assert.equal(requests.length, 0);
  });

  it('starts a private Plex list', async () => {
    const { status, body } = await call<{ id: string; slug: string }>(
      'POST',
      '/api/v1/list/plex',
      { title: 'Harbour Lights', ranked: true }
    );
    assert.equal(status, 201);
    assert.equal(body.id, 'new-1');
    assert.deepEqual(created, [{ title: 'Harbour Lights', ranked: true }]);

    assert.equal(
      (await call('POST', '/api/v1/list/plex', { title: '  ' })).status,
      400
    );
    assert.equal(
      (await call('POST', '/api/v1/list/plex', { title: 'x'.repeat(101) }))
        .status,
      400
    );
  });

  it('adds a title to a Plex list and takes it off, saying which lists have it', async () => {
    let reply = await call(
      'POST',
      '/api/v1/list/plex/Garden/a1-glasswing/item',
      {
        tmdbId: 7,
        mediaType: 'movie',
      }
    );
    assert.equal(reply.status, 201);
    assert.deepEqual(edits, [
      { listId: 'list-a', change: 'add', plexId: 'p7' },
    ]);

    const contains = await call<{ id: string; contains: boolean }[]>(
      'GET',
      '/api/v1/list/plex/contains?tmdbId=7&mediaType=movie'
    );
    assert.deepEqual(
      contains.body.map((l) => [l.id, l.contains]),
      [
        ['list-a', true],
        ['list-b', false],
      ]
    );

    // Already there: Plex isn't asked again.
    await call('POST', '/api/v1/list/plex/Garden/a1-glasswing/item', {
      tmdbId: 7,
      mediaType: 'movie',
    });
    assert.equal(edits.length, 1);

    reply = await call(
      'DELETE',
      '/api/v1/list/plex/Garden/a1-glasswing/item?tmdbId=7&mediaType=movie'
    );
    assert.equal(reply.status, 204);
    assert.deepEqual(edits[1], {
      listId: 'list-a',
      change: 'remove',
      plexId: 'p7',
    });
    // Nothing is requested without auto-request.
    assert.equal(requests.length, 0);
  });

  it("can't put a title on a Plex list that Plex doesn't have", async () => {
    const { status } = await call(
      'POST',
      '/api/v1/list/plex/Garden/a1-glasswing/item',
      { tmdbId: 404, mediaType: 'movie' }
    );
    assert.equal(status, 422);
    assert.equal(edits.length, 0);
  });

  it('auto-requests what is added to a list later, not what was on it', async () => {
    let reply = await call(
      'PUT',
      '/api/v1/list/plex/Garden/a1-glasswing/auto-request',
      { enabled: true }
    );
    assert.equal(reply.status, 200);
    const follow = await getRepository(PlexListFollow).findOneOrFail({
      where: { userId: person.id },
    });
    assert.deepEqual(follow.handled.sort(), ['p1', 'p2', 'p60']);

    // Added on Plex: a film and a season.
    plexLists[0].entries.push(entry('p9'), entry('s80'));
    await checkLists();
    assert.deepEqual(
      requests.map((r) => [r.mediaId, r.mediaType, r.isAutoRequest]),
      [
        [9, 'movie', true],
        [5080, 'tv', true],
      ]
    );

    // Checked again: nothing new.
    await checkLists();
    assert.equal(requests.length, 2);

    // Taken off and put back: asked for again (the request itself refuses a
    // repeat auto-request for what's still here).
    plexLists[0].entries = plexLists[0].entries.filter(
      (e) => e.plexId !== 'p9'
    );
    await checkLists();
    plexLists[0].entries.push(entry('p9'));
    await checkLists();
    assert.equal(requests.length, 3);

    // Added from Seerr AI: requested at once, not again at the check.
    reply = await call('POST', '/api/v1/list/plex/Garden/a1-glasswing/item', {
      tmdbId: 11,
      mediaType: 'movie',
    });
    assert.equal(reply.status, 201);
    assert.equal(
      (reply.body as { request?: { outcome: string } }).request?.outcome,
      'requested'
    );
    await checkLists();
    assert.deepEqual(
      requests.map((r) => r.mediaId),
      [9, 5080, 9, 11]
    );

    // Off: nothing more is requested.
    await call('PUT', '/api/v1/list/plex/Garden/a1-glasswing/auto-request', {
      enabled: false,
    });
    plexLists[0].entries.push(entry('p12'));
    await checkLists();
    assert.equal(requests.length, 4);
    assert.equal(await getRepository(PlexListFollow).count(), 0);
  });

  it("keeps a title for later when the person's request limit is reached", async () => {
    await call('PUT', '/api/v1/list/plex/Garden/a1-glasswing/auto-request', {
      enabled: true,
    });
    mock.method(MediaRequest, 'request', async () => {
      throw new QuotaRestrictedError('limit');
    });
    plexLists[0].entries.push(entry('p13'));
    await checkLists();
    let follow = await getRepository(PlexListFollow).findOneOrFail({
      where: { userId: person.id },
    });
    assert.ok(!follow.handled.includes('p13'));

    mock.method(MediaRequest, 'request', async () => ({ id: 1 }));
    await checkLists();
    follow = await getRepository(PlexListFollow).findOneOrFail({
      where: { userId: person.id },
    });
    assert.ok(follow.handled.includes('p13'));
  });

  it('stops following a list deleted on Plex, and follows a renamed one', async () => {
    await call('PUT', '/api/v1/list/plex/Garden/a1-glasswing/auto-request', {
      enabled: true,
    });
    await call(
      'PUT',
      '/api/v1/list/plex/Garden/b2-static-garden/auto-request',
      { enabled: true }
    );
    // Renamed on Plex: same id, new slug.
    plexLists[0].summary.slug = 'a1-glasswing-two';
    // Deleted on Plex.
    plexLists.splice(1, 1);
    await checkLists();

    const follows = await getRepository(PlexListFollow).find();
    assert.deepEqual(
      follows.map((f) => [f.plexListId, f.slug]),
      [['list-a', 'a1-glasswing-two']]
    );
  });

  it("doesn't take another list with a followed list's old name for it", async () => {
    await call('PUT', '/api/v1/list/plex/Garden/a1-glasswing/auto-request', {
      enabled: true,
    });
    // Deleted, and a new list made with the same name and other titles.
    plexLists[0] = fakeList('list-new', 'a1-glasswing', ['p21', 'p22']);
    await checkLists();

    // Its old page shows the new list: the follow stays, reported, and
    // nothing is requested from the new list.
    assert.equal(requests.length, 0);
    const follow = await getRepository(PlexListFollow).findOneOrFail({
      where: { userId: person.id },
    });
    assert.equal(follow.plexListId, 'list-a');
    assert.ok(follow.problem);
  });

  it("doesn't drop a follow when Plex leaves the list out of a reply", async () => {
    await call('PUT', '/api/v1/list/plex/Garden/a1-glasswing/auto-request', {
      enabled: true,
    });
    const shown = plexLists;
    mock.method(PlexListsAPI.prototype, 'getMyLists', async () => []);
    await checkLists();
    plexLists = shown;
    assert.equal(await getRepository(PlexListFollow).count(), 1);
  });

  it('starts a Plex list with a title on it, or not at all', async () => {
    let reply = await call<{ id: string }>('POST', '/api/v1/list/plex', {
      title: 'Lantern Song',
      tmdbId: 404,
      mediaType: 'movie',
    });
    assert.equal(reply.status, 422);
    assert.equal(created.length, 0);

    reply = await call<{ id: string }>('POST', '/api/v1/list/plex', {
      title: 'Lantern Song',
      tmdbId: 8,
      mediaType: 'movie',
    });
    assert.equal(reply.status, 201);
    assert.deepEqual(edits, [
      { listId: reply.body.id, change: 'add', plexId: 'p8' },
    ]);
  });

  it('keeps a title Plex has no TMDB id for yet, to request later', async () => {
    await call('PUT', '/api/v1/list/plex/Garden/a1-glasswing/auto-request', {
      enabled: true,
    });
    plexLists[0].entries.push(entry('p0'));
    await checkLists();
    const follow = await getRepository(PlexListFollow).findOneOrFail({
      where: { userId: person.id },
    });
    assert.ok(!follow.handled.includes('p0'));
    assert.equal(requests.length, 0);
  });

  it('leaves a follow turned off during a check off', async () => {
    await call('PUT', '/api/v1/list/plex/Garden/a1-glasswing/auto-request', {
      enabled: true,
    });
    plexLists[0].entries.push(entry('p14'));
    // Turned off while the check requests the new title.
    mock.method(MediaRequest, 'request', async () => {
      await getRepository(PlexListFollow).delete({ userId: person.id });
      return { id: 1 };
    });
    await checkLists();
    assert.equal(await getRepository(PlexListFollow).count(), 0);
  });

  it('only lets people with auto-request turn it on', async () => {
    person = await makeUser('plain-plex', Permission.REQUEST, 'plex-token');
    const { status } = await call(
      'PUT',
      '/api/v1/list/plex/Garden/a1-glasswing/auto-request',
      { enabled: true }
    );
    assert.equal(status, 403);
    assert.equal(await getRepository(PlexListFollow).count(), 0);
  });
});
