import RadarrAPI from '@server/api/servarr/radarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Media from '@server/entity/Media';
import MediaDeletion from '@server/entity/MediaDeletion';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import BaseScanner from '@server/lib/scanners/baseScanner';
import { getSettings } from '@server/lib/settings';
import blocklistRoutes from '@server/routes/blocklist';
import listRoutes from '@server/routes/list';
import mediaRoutes from '@server/routes/media';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

/*
 * The real OpenAPI validator sits in front of the routers here, as it does in
 * production. A route or body field missing from seerr-api.yml is rejected
 * before it reaches the router; that has silently disabled finished features
 * before, and a harness that mounts routers directly cannot see it.
 */

setupTestDb();

let server: Server;
let port: number;
let actingAs: User;

let removals: { tmdbId: number; addImportExclusion?: boolean }[] = [];
let radarrFails = false;

// removeMovie is an instance property set in the constructor, so the stub
// swallows that assignment and serves its own.
Object.defineProperty(RadarrAPI.prototype, 'removeMovie', {
  configurable: true,
  set() {},
  get() {
    return async (
      tmdbId: number,
      options: { addImportExclusion?: boolean } = {}
    ) => {
      if (radarrFails) {
        throw new Error('Radarr is unreachable');
      }

      removals.push({ tmdbId, ...options });
    };
  },
});

Object.defineProperty(TheMovieDb.prototype, 'getCollection', {
  configurable: true,
  set() {},
  get() {
    return async () => ({
      id: 5,
      name: 'Saga',
      parts: [
        { id: 801, title: 'Part One' },
        { id: 802, title: 'Part Two' },
      ],
    });
  },
});

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async () => ({ id: 1, title: 'Film', release_date: '2020-01-01' });
  },
});

const call = <T>(method: string, route: string, body?: unknown) =>
  new Promise<{ status: number; body: T }>((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : ({} as T),
          })
        );
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

  return getRepository(User).findOneOrFail({ where: { plexUsername: name } });
};

/** A movie Radarr holds, with a request against it. */
const seedHeldMovie = async (
  tmdbId: number,
  requester: User,
  {
    mediaStatus = MediaStatus.PROCESSING,
    requestStatus = MediaRequestStatus.PENDING,
  }: { mediaStatus?: MediaStatus; requestStatus?: MediaRequestStatus } = {}
) => {
  const media = await getRepository(Media).save(
    new Media({
      tmdbId,
      mediaType: MediaType.MOVIE,
      status: mediaStatus,
      serviceId: 0,
      externalServiceId: 77,
    })
  );

  await getRepository(MediaRequest).save(
    new MediaRequest({
      media,
      requestedBy: requester,
      type: MediaType.MOVIE,
      status: requestStatus,
      is4k: false,
    })
  );

  return media;
};

let admin: User;
let moderator: User;

beforeEach(async () => {
  removals = [];
  radarrFails = false;

  getSettings().radarr = [
    {
      id: 0,
      name: 'Radarr',
      hostname: 'radarr.invalid',
      port: 7878,
      apiKey: 'x',
      useSsl: false,
      activeProfileId: 1,
      activeProfileName: 'Any',
      activeDirectory: '/movies',
      is4k: false,
      isDefault: true,
      minimumAvailability: 'released',
      syncEnabled: false,
      preventSearch: true,
      tags: [],
      tagRequests: false,
    } as never,
  ];

  admin = await makeUser('bl-admin', Permission.ADMIN);
  moderator = await makeUser('bl-moderator', Permission.MANAGE_BLOCKLIST);
  actingAs = admin;

  if (!server) {
    const app = express();
    app.use(express.json());
    app.use(
      OpenApiValidator.middleware({
        apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
        validateRequests: true,
        // Authentication is the routers' job (isAuthenticated); the point here
        // is whether paths and bodies are declared.
        validateSecurity: false,
      })
    );
    app.use((req, _res, next) => {
      (req as unknown as { user: User }).user = actingAs;
      next();
    });
    app.use('/api/v1/list', listRoutes);
    app.use('/api/v1/blocklist', blocklistRoutes);
    app.use('/api/v1/media', mediaRoutes);
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

describe('routes declared in the API spec', () => {
  it('has the validator active (control)', async () => {
    // Without this, every declaration check below would pass vacuously.
    const { status, body } = await call<{ message: string }>(
      'GET',
      '/api/v1/list/1/not-a-route'
    );

    assert.equal(status, 404);
    assert.match(body.message, /not found/i);
  });

  it('accepts the series progress route', async () => {
    const { body: created } = await call<{ id: number }>(
      'POST',
      '/api/v1/list',
      { name: 'Spec check' }
    );

    const { status } = await call('GET', `/api/v1/list/${created.id}/progress`);

    assert.equal(status, 200);
  });

  it('accepts removeFiles on a blocklist request', async () => {
    const { status } = await call('POST', '/api/v1/blocklist', {
      tmdbId: 9001,
      mediaType: 'movie',
      title: 'Nothing held',
      user: admin.id,
      removeFiles: true,
    });

    assert.equal(status, 201);
  });
});

describe('blocklisting something already downloaded', () => {
  it('removes it from Radarr, deletes the files and excludes it from import', async () => {
    await seedHeldMovie(700, moderator);

    const { status, body } = await call<{
      removedFrom: string[];
      failed: unknown[];
      declinedRequests: number;
    }>('POST', '/api/v1/blocklist', {
      tmdbId: 700,
      mediaType: 'movie',
      title: 'Held film',
      user: admin.id,
      removeFiles: true,
    });

    assert.equal(status, 201);
    assert.deepEqual(body.removedFrom, ['Radarr']);
    assert.deepEqual(removals, [{ tmdbId: 700, addImportExclusion: true }]);

    const media = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 700, mediaType: MediaType.MOVIE },
    });
    assert.equal(media.status, MediaStatus.BLOCKLISTED);
    assert.equal(media.serviceId, null, 'no longer tied to Radarr');

    assert.equal(body.declinedRequests, 1);
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { media: { id: media.id } },
    });
    assert.equal(request.status, MediaRequestStatus.DECLINED);

    assert.equal(
      await getRepository(MediaDeletion).countBy({ tmdbId: 700 }),
      1,
      'recorded, so a stale watchlist entry cannot bring it back later'
    );
  });

  it('leaves a request that was already fulfilled as it was', async () => {
    // A request for something already in the library is marked completed as
    // soon as it is saved. It was delivered, so it is not declined.
    await seedHeldMovie(705, moderator, {
      mediaStatus: MediaStatus.AVAILABLE,
      requestStatus: MediaRequestStatus.APPROVED,
    });

    const { body } = await call<{ declinedRequests: number }>(
      'POST',
      '/api/v1/blocklist',
      {
        tmdbId: 705,
        mediaType: 'movie',
        title: 'Delivered film',
        user: admin.id,
        removeFiles: true,
      }
    );

    assert.equal(body.declinedRequests, 0);
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { media: { tmdbId: 705 } },
    });
    assert.equal(request.status, MediaRequestStatus.COMPLETED);
  });

  it('refuses file removal to a non-admin and changes nothing', async () => {
    await seedHeldMovie(701, admin);
    actingAs = moderator;

    const { status } = await call('POST', '/api/v1/blocklist', {
      tmdbId: 701,
      mediaType: 'movie',
      title: 'Held film',
      user: moderator.id,
      removeFiles: true,
    });

    assert.equal(status, 403);
    assert.deepEqual(removals, []);
    assert.equal(
      await getRepository(Blocklist).countBy({ tmdbId: 701 }),
      0,
      'refused before anything was written'
    );
  });

  it('leaves Radarr alone when files are not being removed', async () => {
    await seedHeldMovie(702, admin);

    const { status } = await call('POST', '/api/v1/blocklist', {
      tmdbId: 702,
      mediaType: 'movie',
      title: 'Held film',
      user: admin.id,
    });

    assert.equal(status, 201);
    assert.deepEqual(removals, []);
  });

  it('keeps the blocklist and reports it when Radarr cannot be reached', async () => {
    await seedHeldMovie(703, admin);
    radarrFails = true;

    const { status, body } = await call<{
      removedFrom: string[];
      failed: { service: string }[];
    }>('POST', '/api/v1/blocklist', {
      tmdbId: 703,
      mediaType: 'movie',
      title: 'Held film',
      user: admin.id,
      removeFiles: true,
    });

    assert.equal(status, 201);
    assert.deepEqual(body.removedFrom, []);
    assert.equal(body.failed[0]?.service, 'Radarr');

    const media = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 703, mediaType: MediaType.MOVIE },
    });
    assert.equal(media.status, MediaStatus.BLOCKLISTED);
  });

  it('reports a duplicate as already blocklisted, on either engine', async () => {
    const body = {
      tmdbId: 704,
      mediaType: 'movie',
      title: 'Twice',
      user: admin.id,
    };

    await call('POST', '/api/v1/blocklist', body);
    const { status } = await call('POST', '/api/v1/blocklist', body);

    assert.equal(status, 412);
  });
});

describe('who a blocklist entry is credited to', () => {
  it('is whoever added it, whatever the request claims', async () => {
    actingAs = moderator;
    const { status } = await call('POST', '/api/v1/blocklist', {
      tmdbId: 9100,
      mediaType: 'movie',
      title: 'Claimed',
      user: admin.id,
    });
    assert.equal(status, 201);

    const entry = await getRepository(Blocklist).findOneOrFail({
      where: { tmdbId: 9100 },
    });
    assert.equal(entry.user?.id, moderator.id);
  });
});

describe('a reason for blocklisting', () => {
  it('is stored and returned with the entry', async () => {
    await call('POST', '/api/v1/blocklist', {
      tmdbId: 740,
      mediaType: 'movie',
      title: 'Why not',
      user: admin.id,
      reason: '  Duplicate of the extended cut  ',
    });

    const { body: one } = await call<{ reason: string }>(
      'GET',
      '/api/v1/blocklist/740?mediaType=movie'
    );
    assert.equal(one.reason, 'Duplicate of the extended cut', 'trimmed');

    const { body: list } = await call<{
      results: { tmdbId: number; reason?: string }[];
    }>('GET', '/api/v1/blocklist?take=10&skip=0');
    assert.equal(
      list.results.find((item) => item.tmdbId === 740)?.reason,
      'Duplicate of the extended cut'
    );
  });

  it('pages the list at a hundred at most, and refuses a bad filter', async () => {
    const { status, body } = await call<{ pageInfo: { pageSize: number } }>(
      'GET',
      '/api/v1/blocklist?take=100000'
    );
    assert.equal(status, 200);
    assert.equal(body.pageInfo.pageSize, 100);

    const bad = await call('GET', '/api/v1/blocklist?filter=everything');
    assert.equal(bad.status, 400);
  });

  it('treats a blank reason as no reason', async () => {
    await call('POST', '/api/v1/blocklist', {
      tmdbId: 741,
      mediaType: 'movie',
      title: 'Blank',
      user: admin.id,
      reason: '    ',
    });

    const entry = await getRepository(Blocklist).findOneByOrFail({
      tmdbId: 741,
    });
    assert.equal(entry.reason ?? null, null);
  });

  it('refuses a reason that is too long, storing nothing', async () => {
    const { status } = await call('POST', '/api/v1/blocklist', {
      tmdbId: 742,
      mediaType: 'movie',
      title: 'Too long',
      user: admin.id,
      reason: 'x'.repeat(501),
    });

    assert.equal(status, 400);
    assert.equal(await getRepository(Blocklist).countBy({ tmdbId: 742 }), 0);
  });

  it('applies to every film when blocklisting a collection', async () => {
    const { status } = await call('POST', '/api/v1/blocklist/collection/5', {
      reason: 'Not for this house',
    });

    assert.equal(status, 201);

    const entries = await getRepository(Blocklist).find({
      where: [{ tmdbId: 801 }, { tmdbId: 802 }],
    });
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry) => entry.reason === 'Not for this house'));
  });
});

describe('removing something from the blocklist', () => {
  it('keeps a title that has request history, resetting its status', async () => {
    await seedHeldMovie(710, admin);
    await call('POST', '/api/v1/blocklist', {
      tmdbId: 710,
      mediaType: 'movie',
      title: 'Held film',
      user: admin.id,
      removeFiles: true,
    });

    const { status } = await call(
      'DELETE',
      '/api/v1/blocklist/710?mediaType=movie'
    );

    assert.equal(status, 204);

    const media = await getRepository(Media).findOne({
      where: { tmdbId: 710, mediaType: MediaType.MOVIE },
    });
    assert.ok(media, 'deleting it would have taken its requests with it');
    assert.equal(media?.status, MediaStatus.UNKNOWN);
    assert.equal(await getRepository(MediaRequest).count(), 1);
  });

  it('keeps request history when a whole collection comes off the blocklist', async () => {
    // 801 has been requested; 802 only exists because of the blocklist.
    await seedHeldMovie(801, admin);
    await call('POST', '/api/v1/blocklist/collection/5', {});

    const { status } = await call('DELETE', '/api/v1/blocklist/collection/5');

    assert.equal(status, 204);
    const kept = await getRepository(Media).findOne({
      where: { tmdbId: 801, mediaType: MediaType.MOVIE },
    });
    assert.ok(kept, 'its requests would have gone with it');
    assert.equal(kept?.status, MediaStatus.UNKNOWN);
    assert.equal(await getRepository(MediaRequest).count(), 1);
    assert.equal(await getRepository(Media).countBy({ tmdbId: 802 }), 0);
    assert.equal(await getRepository(Blocklist).count(), 0);
  });

  it('removes a title that only existed because it was blocklisted', async () => {
    await call('POST', '/api/v1/blocklist', {
      tmdbId: 711,
      mediaType: 'movie',
      title: 'Never requested',
      user: admin.id,
    });

    await call('DELETE', '/api/v1/blocklist/711?mediaType=movie');

    assert.equal(await getRepository(Media).countBy({ tmdbId: 711 }), 0);
  });
});

describe("the manage panel's remove-file action", () => {
  it('still removes the file, without an import exclusion', async () => {
    // Refactored onto the shared removal; its behaviour must not change.
    const media = await seedHeldMovie(730, admin, {
      mediaStatus: MediaStatus.AVAILABLE,
    });

    const { status } = await call('DELETE', `/api/v1/media/${media.id}/file`);

    assert.equal(status, 204);
    assert.deepEqual(removals, [{ tmdbId: 730, addImportExclusion: false }]);

    const after = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.equal(after.status, MediaStatus.DELETED);
    assert.equal(after.serviceId, null);
  });
});

describe('scans after blocklisting', () => {
  class ProbeScanner extends BaseScanner<unknown> {
    constructor() {
      super('Probe Scanner', {});
    }

    public seeMovie(tmdbId: number) {
      return this.processMovie(tmdbId, { hasFile: true, title: 'Probe' });
    }
  }

  it('does not mark a blocklisted title available again', async () => {
    // Plex can keep listing a deleted file until its trash is emptied.
    await getRepository(Media).save(
      new Media({
        tmdbId: 720,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.BLOCKLISTED,
        status4k: MediaStatus.BLOCKLISTED,
      })
    );

    await new ProbeScanner().seeMovie(720);

    const media = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 720, mediaType: MediaType.MOVIE },
    });
    assert.equal(media.status, MediaStatus.BLOCKLISTED);
  });

  it('still marks an ordinary title available', async () => {
    await getRepository(Media).save(
      new Media({
        tmdbId: 721,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
      })
    );

    await new ProbeScanner().seeMovie(721);

    const media = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 721, mediaType: MediaType.MOVIE },
    });
    assert.equal(media.status, MediaStatus.AVAILABLE);
  });
});
