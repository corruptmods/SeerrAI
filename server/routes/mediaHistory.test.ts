import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import EpisodeRequest from '@server/entity/EpisodeRequest';
import Media from '@server/entity/Media';
import MediaEvent from '@server/entity/MediaEvent';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { MediaEventType, recordMediaEvent } from '@server/lib/mediaHistory';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import blocklistRoutes from '@server/routes/blocklist';
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
 * A title's history, recorded by the real save hooks and routes on a real
 * database, and read back through the route the manage panel uses.
 */

setupTestDb();

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async ({ movieId }: { movieId: number }) => ({
      id: movieId,
      title: 'Film',
    });
  },
});

// Saving a series request sends its "pending" notification, which looks the
// show up.
Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  configurable: true,
  set() {},
  get() {
    return async ({ tvId }: { tvId: number }) => ({
      id: tvId,
      name: 'Show',
      seasons: [],
      external_ids: {},
      keywords: { results: [] },
    });
  },
});

let server: Server;
let port: number;
let actingAs: User;
let admin: User;
let member: User;

const call = <T = unknown>(method: string, route: string, body?: unknown) =>
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
        res.on('data', (c) => (raw += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : undefined,
          })
        );
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

type Event = {
  type: string;
  is4k: boolean;
  detail: string | null;
  user: { displayName: string } | null;
};
const history = async (mediaType: string, tmdbId: number) =>
  (await call<Event[]>('GET', `/api/v1/media/history/${mediaType}/${tmdbId}`))
    .body;
// Oldest first, as "type[4K] by user: detail", for readable assertions.
const story = (events: Event[]) =>
  [...events]
    .reverse()
    .map(
      (e) =>
        `${e.type}${e.is4k ? '[4K]' : ''}${e.user ? ' by ' + e.user.displayName : ''}${e.detail ? ': ' + e.detail : ''}`
    );

beforeEach(async () => {
  admin = await getRepository(User).save(
    new User({
      email: 'hist-admin@test.local',
      plexUsername: 'Alex',
      permissions: Permission.ADMIN,
      avatar: '',
    })
  );
  member = await getRepository(User).save(
    new User({
      email: 'hist-member@test.local',
      plexUsername: 'Jordan',
      permissions: Permission.REQUEST,
      avatar: '',
    })
  );
  actingAs = admin;

  if (!server) {
    const app = express();
    app.use(express.json());
    app.use(
      OpenApiValidator.middleware({
        apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
        validateRequests: true,
        validateSecurity: false,
      })
    );
    app.use((req, _res, next) => {
      (req as unknown as { user: User }).user = actingAs;
      next();
    });
    app.use('/api/v1/media', mediaRoutes);
    app.use('/api/v1/blocklist', blocklistRoutes);
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

after(() => server?.close());

const tvRequest = async (
  tmdbId: number,
  seasons: SeasonRequest[],
  is4k = false
) => {
  const media = await getRepository(Media).save(
    new Media({ tmdbId, mediaType: MediaType.TV, status: MediaStatus.PENDING })
  );
  const request = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.TV,
      media,
      requestedBy: member,
      status: MediaRequestStatus.PENDING,
      is4k,
      seasons,
    })
  );
  return { media, request };
};

describe('what a request records', () => {
  it('who asked for which seasons', async () => {
    await tvRequest(501, [
      new SeasonRequest({
        seasonNumber: 1,
        status: MediaRequestStatus.PENDING,
      }),
      new SeasonRequest({
        seasonNumber: 2,
        status: MediaRequestStatus.PENDING,
      }),
    ]);
    assert.deepEqual(story(await history('tv', 501)), [
      'requested by Jordan: Seasons 1, 2',
    ]);
  });

  it('who asked for a single episode', async () => {
    await tvRequest(502, [
      new SeasonRequest({
        seasonNumber: 3,
        status: MediaRequestStatus.PENDING,
        episodes: [new EpisodeRequest({ episodeNumber: 4 })],
      }),
    ]);
    assert.deepEqual(story(await history('tv', 502)), [
      'requested by Jordan: Season 3, episode 4',
    ]);
  });

  it('approval, then the reason it could not be sent, once each', async () => {
    // A Sonarr exists but none is the default: Seerr cannot send it, and
    // marks it failed with the reason. (With no Sonarr at all it waits.)
    const previousSonarr = getSettings().sonarr;
    getSettings().sonarr = [
      {
        id: 0,
        name: 'Sonarr',
        hostname: '127.0.0.1',
        port: 1,
        apiKey: 'k',
        useSsl: false,
        baseUrl: '',
        activeProfileId: 1,
        activeProfileName: 'Any',
        activeDirectory: '/tv',
        activeLanguageProfileId: 1,
        activeAnimeProfileId: null,
        activeAnimeLanguageProfileId: null,
        activeAnimeProfileName: null,
        activeAnimeDirectory: null,
        is4k: false,
        isDefault: false,
        enableSeasonFolders: true,
        syncEnabled: false,
        preventSearch: false,
        tagRequests: false,
        tags: [],
        animeTags: [],
        overrideRule: [],
      } as never,
    ];
    const { request } = await tvRequest(503, [
      new SeasonRequest({
        seasonNumber: 1,
        status: MediaRequestStatus.PENDING,
      }),
    ]);
    request.status = MediaRequestStatus.APPROVED;
    request.modifiedBy = admin;
    await getRepository(MediaRequest).save(request);

    const events = story(await history('tv', 503));
    assert.equal(events[0], 'requested by Jordan: Season 1');
    assert.equal(events[1], 'approved by Alex');
    assert.equal(
      events.filter((e) => e.startsWith('failed')).length,
      1,
      'no Sonarr here: one failure, not a duplicate'
    );
    assert.match(
      events.find((e) => e.startsWith('failed'))!,
      /^failed: .+/,
      'with its reason'
    );
    getSettings().sonarr = previousSonarr;
  });

  it('a decline, by whom', async () => {
    const { request } = await tvRequest(504, [
      new SeasonRequest({
        seasonNumber: 1,
        status: MediaRequestStatus.PENDING,
      }),
    ]);
    request.status = MediaRequestStatus.DECLINED;
    request.modifiedBy = admin;
    await getRepository(MediaRequest).save(request);
    assert.deepEqual(story(await history('tv', 504)), [
      'requested by Jordan: Season 1',
      'declined by Alex',
    ]);
  });
});

describe('what the title records', () => {
  it('status changes, 4K kept apart, and nothing when unchanged', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 601,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PENDING,
      })
    );
    for (const change of [
      { status: MediaStatus.PROCESSING },
      { status: MediaStatus.PROCESSING },
      { status: MediaStatus.AVAILABLE },
      { status4k: MediaStatus.PROCESSING },
      { status: MediaStatus.DELETED },
    ]) {
      Object.assign(media, change);
      await getRepository(Media).save(media);
    }
    assert.deepEqual(story(await history('movie', 601)), [
      'processing',
      'available',
      'processing[4K]',
      'removed',
    ]);
  });
});

describe('blocklisting', () => {
  it('records who blocklisted and why, then who removed it', async () => {
    await call('POST', '/api/v1/blocklist', {
      tmdbId: 701,
      mediaType: 'movie',
      title: 'Film',
      user: admin.id,
      reason: 'Wrong edition',
    });
    await call('DELETE', '/api/v1/blocklist/701?mediaType=movie');
    assert.deepEqual(story(await history('movie', 701)), [
      'blocklisted by Alex: Wrong edition',
      'unblocklisted by Alex',
    ]);
  });
});

describe('reading it', () => {
  it('outlives the media row', async () => {
    const { media } = await tvRequest(801, [
      new SeasonRequest({
        seasonNumber: 1,
        status: MediaRequestStatus.PENDING,
      }),
    ]);
    await getRepository(Media).delete(media.id);
    assert.deepEqual(story(await history('tv', 801)), [
      'requested by Jordan: Season 1',
    ]);
  });

  it('is for request managers and admins only', async () => {
    actingAs = member;
    assert.equal(
      (await call('GET', '/api/v1/media/history/movie/1')).status,
      403
    );
  });

  it('never throws when a write fails', async () => {
    await assert.doesNotReject(
      recordMediaEvent({
        tmdbId: 1,
        mediaType: null as never,
        type: MediaEventType.ADDED,
      })
    );
    assert.equal(await getRepository(MediaEvent).countBy({ tmdbId: 1 }), 0);
  });

  // On Postgres a refused write aborts the transaction it is in, so the save
  // it was recorded for, and everything after it, would be lost with it.
  it('never undoes the save it is written in when a write fails', async () => {
    await dataSource.transaction(async (em) => {
      await recordMediaEvent(
        { tmdbId: 1, mediaType: MediaType.MOVIE, type: MediaEventType.ADDED },
        em
      );
      await recordMediaEvent(
        { tmdbId: 2, mediaType: null as never, type: MediaEventType.ADDED },
        em
      );
      await recordMediaEvent(
        { tmdbId: 3, mediaType: MediaType.MOVIE, type: MediaEventType.ADDED },
        em
      );
    });

    assert.deepEqual(
      (await getRepository(MediaEvent).find({ order: { tmdbId: 'ASC' } })).map(
        (event) => event.tmdbId
      ),
      [1, 3]
    );
  });
});
