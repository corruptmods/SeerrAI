import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import type { RadarrMovieOptions } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import OverrideRule from '@server/entity/OverrideRule';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { Permission } from '@server/lib/permissions';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import requestRoutes from './request';

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

const getMovieImpl: (args: {
  movieId: number;
  language?: string;
}) => Promise<TmdbMovieDetails> = async ({ movieId }) => fakeTmdbMovie(movieId);

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async (args: { movieId: number; language?: string }) =>
      getMovieImpl(args);
  },
  set() {},
  configurable: true,
});

const getTvShowImpl: (args: {
  tvId: number;
  language?: string;
}) => Promise<TmdbTvDetails> = async ({ tvId }) => fakeTmdbShow(tvId);

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async (args: { tvId: number; language?: string }) =>
      getTvShowImpl(args);
  },
  set() {},
  configurable: true,
});

/** Genres and language for particular movies; others are English, no genre. */
const movieDetails = new Map<
  number,
  {
    genres: { id: number; name: string }[];
    original_language: string;
    release_date?: string;
  }
>();

function fakeTmdbMovie(tmdbId: number): TmdbMovieDetails {
  return {
    id: tmdbId,
    genres: [],
    original_language: 'en',
    keywords: { keywords: [] },
    external_ids: {},
    ...movieDetails.get(tmdbId),
  } as unknown as TmdbMovieDetails;
}

/** Genres and language for particular shows; others are English, no genre. */
const showDetails = new Map<
  number,
  { genres: { id: number; name: string }[]; original_language: string }
>();

function fakeTmdbShow(tmdbId: number): TmdbTvDetails {
  return {
    id: tmdbId,
    genres: [],
    original_language: 'en',
    keywords: { results: [] },
    external_ids: {},
    ...showDetails.get(tmdbId),
  } as unknown as TmdbTvDetails;
}

function configureRadarr(overrides: Partial<RadarrSettings>[]): void {
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
    activeDirectory: '/movies',
    is4k: false,
    minimumAvailability: 'released',
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as RadarrSettings[];
}

function configureSonarr(overrides: Partial<SonarrSettings>[]): void {
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
}

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/request', requestRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(async () => {
  app = createApp();
});

beforeEach(() => {
  sendNotificationMock.resetCalls();
});

setupTestDb();

/** A seeded user's id, by email. */
const userIdOf = async (email: string) =>
  (await getRepository(User).findOneByOrFail({ email })).id;

async function loginAs(email: string, password: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent.post('/auth/local').send({ email, password });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

async function seedRequest(status = MediaRequestStatus.PENDING) {
  const userRepo = getRepository(User);
  const mediaRepo = getRepository(Media);
  const requestRepo = getRepository(MediaRequest);

  const requestedBy = await userRepo.findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });

  const media = await mediaRepo.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 12345,
      status: MediaStatus.UNKNOWN,
      status4k: MediaStatus.UNKNOWN,
    })
  );

  const created = await requestRepo.save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status,
      media,
      requestedBy,
      is4k: false,
      updatedAt: new Date('2025-03-01T00:00:00.000Z'),
    })
  );

  return requestRepo.findOneOrFail({
    where: { id: created.id },
    relations: { requestedBy: true, modifiedBy: true },
  });
}

describe('DELETE /request/:requestId', () => {
  it('allows the owner to delete their own pending request', async () => {
    const mediaRequest = await seedRequest();

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 204);
  });

  it('allows an admin to delete any pending request', async () => {
    const mediaRequest = await seedRequest();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 204);
  });

  it('prevents a non-owner non-admin from deleting a pending request', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    // Create a request owned by admin, then try to delete as friend
    const owner = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 54321,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const mediaRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: owner,
        is4k: false,
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 401);
  });

  it('prevents the owner from deleting an approved request', async () => {
    const mediaRequest = await seedRequest(MediaRequestStatus.APPROVED);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 401);
  });

  it('returns 404 for a non-existent request', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete('/request/99999999');

    assert.strictEqual(res.status, 404);
  });

  it('deletes a request once when two deletes race', async () => {
    const repo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const results = await Promise.all([
      admin.delete(`/request/${mediaRequest.id}`),
      admin.delete(`/request/${mediaRequest.id}`),
    ]);

    assert.deepStrictEqual(results.map((r) => r.status).sort(), [204, 404]);
    assert.strictEqual(await repo.count({ where: { id: mediaRequest.id } }), 0);
  });
});

describe('PUT /request/:requestId (movie)', () => {
  it('persists server and root folder changes to the database', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      serverId: 3,
      profileId: 7,
      rootFolder: '/updated/movies',
      tags: [1, 2],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, 3);
    assert.strictEqual(saved.profileId, 7);
    assert.strictEqual(saved.rootFolder, '/updated/movies');
  });

  it('refuses to modify a request that is no longer pending', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest(MediaRequestStatus.APPROVED);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      serverId: 3,
      rootFolder: '/updated/movies',
    });

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /pending/i);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, null);
    assert.strictEqual(saved.rootFolder, null);
  });
});

async function seedUser(
  email: string,
  quotas: {
    movieQuotaLimit?: number;
    tvQuotaLimit?: number;
    tvQuotaDays?: number;
  } = {}
) {
  const userRepo = getRepository(User);
  const user = await userRepo.findOneOrFail({ where: { email } });
  Object.assign(user, quotas);

  return userRepo.save(user);
}

async function seedTvMedia(tmdbId: number) {
  const mediaRepo = getRepository(Media);

  return (
    (await mediaRepo.findOne({
      where: { tmdbId, mediaType: MediaType.TV },
    })) ??
    (await mediaRepo.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    ))
  );
}

async function seedMediaSeasons(
  tmdbId: number,
  seasons: { seasonNumber: number; status: MediaStatus }[]
) {
  const media = await seedTvMedia(tmdbId);
  media.seasons = seasons.map(
    ({ seasonNumber, status }) =>
      new Season({ seasonNumber, status, status4k: MediaStatus.UNKNOWN })
  );

  return getRepository(Media).save(media);
}

async function seedTvRequest(
  requestedBy: User,
  seasons: number[],
  { tmdbId = 67890, ignoreQuota = false, createdAt = new Date() } = {}
) {
  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.TV,
      status: MediaRequestStatus.PENDING,
      media: await seedTvMedia(tmdbId),
      requestedBy,
      is4k: false,
      ignoreQuota,
      createdAt,
      seasons: seasons.map(
        (seasonNumber) =>
          new SeasonRequest({
            seasonNumber,
            status: MediaRequestStatus.PENDING,
          })
      ),
    })
  );
}

describe('PUT /request/:requestId (tv)', () => {
  it('does not add a season held by another request', async () => {
    const requestRepo = getRepository(MediaRequest);

    const owner = await seedUser('admin@seerr.dev');
    const otherUser = await seedUser('friend@seerr.dev');

    const mediaRequest = await seedTvRequest(owner, [1, 2]);
    const otherRequest = await seedTvRequest(otherUser, [3]);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );

    const otherSaved = await requestRepo.findOneOrFail({
      where: { id: otherRequest.id },
    });
    assert.deepStrictEqual(
      otherSaved.seasons.map((s) => s.seasonNumber),
      [3]
    );
  });

  it('gives a season to only one of two concurrent edits', async () => {
    const requestRepo = getRepository(MediaRequest);

    const owner = await seedUser('admin@seerr.dev');
    const otherUser = await seedUser('friend@seerr.dev');

    const mediaRequest = await seedTvRequest(owner, [1]);
    const otherRequest = await seedTvRequest(otherUser, [3]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const friend = await loginAs('friend@seerr.dev', 'test1234');

    const [adminRes, friendRes] = await Promise.all([
      admin
        .put(`/request/${mediaRequest.id}`)
        .send({ mediaType: MediaType.TV, seasons: [1, 2] }),
      friend
        .put(`/request/${otherRequest.id}`)
        .send({ mediaType: MediaType.TV, seasons: [3, 2] }),
    ]);

    assert.strictEqual(adminRes.status, 200);
    assert.strictEqual(friendRes.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    const otherSaved = await requestRepo.findOneOrFail({
      where: { id: otherRequest.id },
    });

    const holders = [saved, otherSaved].filter((r) =>
      r.seasons.some((s) => s.seasonNumber === 2)
    );
    assert.strictEqual(holders.length, 1);

    assert.deepStrictEqual(
      [...saved.seasons, ...otherSaved.seasons]
        .map((s) => s.seasonNumber)
        .sort((a, b) => a - b),
      [1, 2, 3]
    );
  });
});

describe('PUT /request/:requestId (season availability)', () => {
  it('does not add a season the media already has', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('friend@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 2, status: MediaStatus.AVAILABLE },
    ]);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 3]
    );
  });

  it('returns 202 when every requested season is already covered', async () => {
    const owner = await seedUser('friend@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 2, status: MediaStatus.AVAILABLE },
    ]);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [2],
    });

    assert.strictEqual(res.status, 202);
  });

  it('keeps the seasons it already holds once they are available', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('friend@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1, 2]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 1, status: MediaStatus.AVAILABLE },
      { seasonNumber: 2, status: MediaStatus.PROCESSING },
    ]);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      serverId: 3,
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
    // Without advanced options the server stays whatever it was.
    assert.strictEqual(saved.serverId, mediaRequest.serverId ?? null);
  });

  it('does not charge quota for a season the media already has', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('friend@seerr.dev', { tvQuotaLimit: 1 });
    const mediaRequest = await seedTvRequest(owner, [1]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 2, status: MediaStatus.AVAILABLE },
    ]);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber),
      [1]
    );
  });
});

describe('PUT /request/:requestId (quota)', () => {
  it('rejects adding seasons beyond the season limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('friend@seerr.dev', { tvQuotaLimit: 2 });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
  });

  it('rejects adding seasons to a request older than the quota window', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('friend@seerr.dev', {
      tvQuotaLimit: 2,
      tvQuotaDays: 7,
    });
    const mediaRequest = await seedTvRequest(owner, [1, 2], {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
  });

  it('allows swapping seasons at the season limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('friend@seerr.dev', { tvQuotaLimit: 2 });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [3, 4],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [3, 4]
    );
  });

  it('rejects reassignment to a user without room for the existing seasons', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('admin@seerr.dev');
    const target = await seedUser('friend@seerr.dev', { tvQuotaLimit: 1 });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      userId: target.id,
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.requestedBy.id, owner.id);
  });

  it('rejects reassignment of a movie request to a user at their limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRepo = getRepository(Media);

    const owner = await seedUser('admin@seerr.dev');
    const target = await seedUser('friend@seerr.dev', { movieQuotaLimit: 1 });

    // Uses up the target's single movie request
    await seedRequest();

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 55555,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const mediaRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: owner,
        is4k: false,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      userId: target.id,
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.requestedBy.id, owner.id);
  });

  it('allows reassignment to a user who bypasses quotas', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('friend@seerr.dev', { tvQuotaLimit: 1 });
    const target = await seedUser('admin@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      userId: target.id,
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.requestedBy.id, target.id);
  });

  it('allows an edit that exceeds the limit when the request ignores quota', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('friend@seerr.dev', { tvQuotaLimit: 2 });

    await seedTvRequest(owner, [1, 2], { tmdbId: 77777 });
    const mediaRequest = await seedTvRequest(owner, [1, 2], {
      ignoreQuota: true,
    });

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2, 3]
    );
  });

  it('charges only the net increase when an edit both adds and removes', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('friend@seerr.dev', { tvQuotaLimit: 4 });
    const mediaRequest = await seedTvRequest(owner, [1, 2, 3]);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 4, 5],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2, 4, 5]
    );
  });
});

describe('POST /request/:requestId/:status', () => {
  const cases = [
    { action: 'approve', expected: MediaRequestStatus.APPROVED },
    { action: 'decline', expected: MediaRequestStatus.DECLINED },
  ] as const;

  for (const { action, expected } of cases) {
    it(`transitions to ${action}d and records the acting user`, async () => {
      const repo = getRepository(MediaRequest);
      const pending = await seedRequest();
      const admin = await loginAs('admin@seerr.dev', 'test1234');

      const res = await admin.post(`/request/${pending.id}/${action}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, expected);
      assert.strictEqual(
        res.body.modifiedBy.id,
        await userIdOf('admin@seerr.dev')
      );

      const persisted = await repo.findOneOrFail({
        where: { id: pending.id },
        relations: { modifiedBy: true },
      });

      assert.strictEqual(persisted.status, expected);
      assert.strictEqual(persisted.modifiedBy?.email, 'admin@seerr.dev');
      assert.ok(persisted.updatedAt > pending.updatedAt);
    });
  }

  it('rejects a status the route does not define', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${pending.id}/frobnicate`);

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /approve/i);

    const persisted = await repo.findOneOrFail({
      where: { id: pending.id },
      relations: { modifiedBy: true },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.PENDING);
    assert.ok(!persisted.modifiedBy);
  });

  it('refuses to act on a request that is no longer pending', async () => {
    const repo = getRepository(MediaRequest);
    const approved = await seedRequest(MediaRequestStatus.APPROVED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${approved.id}/decline`);

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /pending/i);

    const persisted = await repo.findOneOrFail({ where: { id: approved.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
  });

  it('applies only one of a concurrent approve and decline', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const [approve, decline] = await Promise.all([
      admin.post(`/request/${pending.id}/approve`),
      admin.post(`/request/${pending.id}/decline`),
    ]);

    assert.deepStrictEqual([approve.status, decline.status].sort(), [200, 409]);

    const persisted = await repo.findOneOrFail({ where: { id: pending.id } });
    assert.strictEqual(
      persisted.status,
      approve.status === 200
        ? MediaRequestStatus.APPROVED
        : MediaRequestStatus.DECLINED
    );
  });

  it('rejects the removed pending verb even on a non-pending request', async () => {
    const repo = getRepository(MediaRequest);
    const declined = await seedRequest(MediaRequestStatus.DECLINED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${declined.id}/pending`);

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /approve/i);

    const persisted = await repo.findOneOrFail({ where: { id: declined.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.DECLINED);
  });
});

describe('POST /request/:requestId/retry', () => {
  it('re-approves a failed request and records the acting user', async () => {
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${failed.id}/retry`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(
      res.body.modifiedBy.id,
      await userIdOf('admin@seerr.dev')
    );

    const persisted = await repo.findOneOrFail({
      where: { id: failed.id },
      relations: { modifiedBy: true },
    });

    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(persisted.modifiedBy?.email, 'admin@seerr.dev');
    assert.ok(persisted.updatedAt > failed.updatedAt);
  });

  it('refuses to retry a request that has not failed', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${pending.id}/retry`);

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /failed/i);

    const persisted = await repo.findOneOrFail({ where: { id: pending.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.PENDING);
  });

  it('sends a concurrently retried request to *arr once', async (t) => {
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const sendToRadarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );

    const results = await Promise.all([
      admin.post(`/request/${failed.id}/retry`),
      admin.post(`/request/${failed.id}/retry`),
    ]);

    assert.deepStrictEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.strictEqual(sendToRadarr.mock.callCount(), 1);

    const persisted = await repo.findOneOrFail({ where: { id: failed.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
  });
});

describe('DELETE /request/:requestId, deleted media status restoration', () => {
  async function seedDeletedMediaScenario() {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99001,
        status: MediaStatus.DELETED,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const staleRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: false,
        isAutoRequest: true,
      })
    );

    media.status = MediaStatus.PENDING;
    await mediaRepo.save(media);

    const newRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    return { media, staleRequest, newRequest, admin };
  }

  it('restores media status to DELETED when the re-request is deleted and a stale completed request remains', async () => {
    const mediaRepo = getRepository(Media);
    const { media, newRequest } = await seedDeletedMediaScenario();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${newRequest.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.DELETED);
  });

  it('restores media status4k to DELETED when the re-request is deleted and a stale completed request remains', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99003,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.DELETED,
      })
    );

    await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: true,
        isAutoRequest: true,
      })
    );

    media.status4k = MediaStatus.PENDING;
    await mediaRepo.save(media);

    const newRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: true,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${newRequest.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status4k, MediaStatus.DELETED);
  });

  it('resets media status to UNKNOWN when the stale completed request is also deleted', async () => {
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);
    const { media, newRequest, staleRequest } =
      await seedDeletedMediaScenario();

    const agent = await loginAs('admin@seerr.dev', 'test1234');

    await agent.delete(`/request/${newRequest.id}`);

    const res = await agent.delete(`/request/${staleRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.UNKNOWN);

    const remaining = await requestRepo.find({
      where: { media: { id: media.id } },
    });
    assert.strictEqual(remaining.length, 0);
  });

  it('resets media status4k to UNKNOWN when the stale completed 4K request is also deleted', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99004,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.DELETED,
      })
    );

    const staleRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: true,
        isAutoRequest: true,
      })
    );

    media.status4k = MediaStatus.PENDING;
    await mediaRepo.save(media);

    const newRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: true,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');

    await agent.delete(`/request/${newRequest.id}`);

    const res = await agent.delete(`/request/${staleRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status4k, MediaStatus.UNKNOWN);
  });

  it('does not reset media status when other active requests still exist', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99002,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const req1 = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${req1.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.PENDING);
  });

  it('does not reset media status when status is PARTIALLY_AVAILABLE and only completed requests remain', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99005,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const completedRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${completedRequest.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.PARTIALLY_AVAILABLE);
  });
});

describe('POST /request (movie), override rules', () => {
  it('applies an override rule when the default Radarr server id differs from its array index', async () => {
    configureRadarr([{ id: 5, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 5,
        users: String(friend.id),
        rootFolder: '/overridden/movies',
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88001,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/movies');
  });

  it('applies an override rule when the default Radarr server id matches its array index (sanity check)', async () => {
    configureRadarr([{ id: 0, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 0,
        users: String(friend.id),
        rootFolder: '/overridden/movies',
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88002,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/movies');
  });

  it('does not apply an unrelated override rule when there is no default Radarr server configured', async () => {
    getSettings().radarr = [];
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 999,
        users: String(friend.id),
        rootFolder: '/overridden/movies',
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88005,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
  });
});

describe('POST /request (tv), override rules', () => {
  it('applies an override rule when the default Sonarr server id differs from its array index', async () => {
    configureSonarr([{ id: 5, isDefault: true, is4k: false }]);
    getSettings().radarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 5,
        users: String(friend.id),
        rootFolder: '/overridden/tv',
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88003,
      seasons: [1],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/tv');
  });

  it('applies an override rule when the default Sonarr server id matches its array index (sanity check)', async () => {
    configureSonarr([{ id: 0, isDefault: true, is4k: false }]);
    getSettings().radarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 0,
        users: String(friend.id),
        rootFolder: '/overridden/tv',
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88004,
      seasons: [1],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/tv');
  });

  it('does not apply an unrelated override rule when there is no default Sonarr server configured', async () => {
    getSettings().radarr = [];
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 999,
        users: String(friend.id),
        rootFolder: '/overridden/tv',
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88006,
      seasons: [1],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
  });
});

describe('POST /request, override rules and requester choices', () => {
  async function requestWithRule(permissions: number) {
    configureRadarr([{ id: 1, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const requester = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    requester.permissions = permissions;
    await userRepo.save(requester);

    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 1,
        rootFolder: '/rule',
        profileId: 7,
        tags: '2',
      })
    );

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    return agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88010,
      serverId: 1,
      rootFolder: '/chosen',
      tags: [],
    });
  }

  it('keeps what an advanced requester sets and fills the rest from the rule', async () => {
    const res = await requestWithRule(
      Permission.REQUEST | Permission.REQUEST_ADVANCED
    );

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/chosen');
    assert.strictEqual(res.body.profileId, 7);
    assert.deepStrictEqual(res.body.tags, []);
  });

  it('keeps what a request manager sets and fills the rest from the rule', async (t) => {
    // Manage Requests auto-approves; keep it from calling Radarr
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );
    const res = await requestWithRule(
      Permission.REQUEST | Permission.MANAGE_REQUESTS
    );

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/chosen');
    assert.strictEqual(res.body.profileId, 7);
    assert.deepStrictEqual(res.body.tags, []);
  });

  it('applies the rule over what a regular requester sets', async () => {
    const res = await requestWithRule(Permission.REQUEST);

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/rule');
  });
});

describe('DELETE /request/:requestId, orphaned season status reset', () => {
  async function seedTvShow(
    tmdbId: number,
    seasons: Partial<Season>[]
  ): Promise<Media> {
    const mediaRepo = getRepository(Media);

    return mediaRepo.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
        seasons: seasons.map((season) => new Season(season)),
      })
    );
  }

  async function seedTvRequest(
    media: Media,
    seasonNumbers: number[]
  ): Promise<MediaRequest> {
    const userRepo = getRepository(User);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    return requestRepo.save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: false,
        seasons: seasonNumbers.map(
          (seasonNumber) =>
            new SeasonRequest({
              seasonNumber,
              status: MediaRequestStatus.APPROVED,
            })
        ),
      })
    );
  }

  it('resets a request-covered PROCESSING season to UNKNOWN so it can be re-requested', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99101, [
      { seasonNumber: 1, status: MediaStatus.PROCESSING },
    ]);
    const tvRequest = await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${tvRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(updated.seasons[0].status, MediaStatus.UNKNOWN);

    const friend = await loginAs('friend@seerr.dev', 'test1234');
    const reRequest = await friend.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 99101,
      seasons: [1],
    });
    assert.strictEqual(reRequest.status, 201);
  });

  it('does not touch PROCESSING seasons the deleted request did not cover', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99102, [
      { seasonNumber: 1, status: MediaStatus.PROCESSING },
      { seasonNumber: 2, status: MediaStatus.PROCESSING },
    ]);
    const tvRequest = await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${tvRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    const seasonOne = updated.seasons.find((s) => s.seasonNumber === 1);
    const seasonTwo = updated.seasons.find((s) => s.seasonNumber === 2);
    assert.strictEqual(seasonOne?.status, MediaStatus.UNKNOWN);
    assert.strictEqual(seasonTwo?.status, MediaStatus.PROCESSING);
  });

  it('keeps a season PROCESSING while another active request still covers it', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99103, [
      { seasonNumber: 1, status: MediaStatus.PROCESSING },
    ]);
    const firstRequest = await seedTvRequest(media, [1]);
    await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${firstRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.seasons[0].status, MediaStatus.PROCESSING);
  });

  it('leaves season status4k untouched when deleting a non-4K request', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99104, [
      {
        seasonNumber: 1,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.PROCESSING,
      },
    ]);
    const tvRequest = await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${tvRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.seasons[0].status, MediaStatus.UNKNOWN);
    assert.strictEqual(updated.seasons[0].status4k, MediaStatus.PROCESSING);
  });
});

describe('advanced request options', () => {
  it('ignores server, profile, folder and tags from someone not allowed them', async () => {
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 777,
      serverId: 7,
      profileId: 999,
      rootFolder: '/somewhere/else',
      tags: [42],
    });
    assert.strictEqual(res.status, 201);

    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: res.body.id },
    });
    assert.notStrictEqual(saved.serverId, 7);
    assert.notStrictEqual(saved.profileId, 999);
    assert.notStrictEqual(saved.rootFolder, '/somewhere/else');
    assert.ok(!saved.tags?.includes(42));
  });

  it('does not let a film request be edited by calling it a series', async () => {
    const mediaRequest = await seedRequest();
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1],
      serverId: 7,
      rootFolder: '/somewhere/else',
    });
    assert.strictEqual(res.status, 403);
  });
});

describe("GET /request/:requestId, the requester's own settings", () => {
  it('never carries their notification credentials', async () => {
    const seeded = await seedRequest();
    const friend = await getRepository(User).findOneOrFail({
      where: { id: seeded.requestedBy.id },
      relations: { settings: true },
    });
    friend.settings ??= new UserSettings();
    friend.settings.pushbulletAccessToken = 'SECRET-PUSHBULLET';
    friend.settings.pgpKey = 'SECRET-PGP';
    await getRepository(User).save(friend);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.get(`/request/${seeded.id}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.requestedBy.id, friend.id);
    assert.ok(!('settings' in res.body.requestedBy));
    assert.doesNotMatch(JSON.stringify(res.body), /SECRET-/);
  });

  it("never carries anyone's email, Plex id or Plex sign-in state", async () => {
    const seeded = await seedRequest();
    // Signed in first: with the owner's Plex id changed, the friend's would
    // no longer be the owner's, and plex.tv is not there to vouch for them.
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const userRepo = getRepository(User);
    const admin = await userRepo.findOneByOrFail({
      email: 'admin@seerr.dev',
    });
    admin.plexId = 424242;
    admin.plexTokenExpiredAt = new Date();
    await userRepo.save(admin);
    await getRepository(MediaRequest).update(seeded.id, { modifiedBy: admin });

    for (const path of [`/request/${seeded.id}`, '/request?take=10']) {
      const res = await agent.get(path);
      assert.strictEqual(res.status, 200, path);
      const body = JSON.stringify(res.body);
      assert.doesNotMatch(body, /@seerr\.dev/, path);
      assert.doesNotMatch(body, /424242|plexTokenExpiredAt/, path);
    }
  });
});

describe('POST /request/missing', () => {
  it('requests only what nothing has yet, and says what happened to each', async () => {
    getSettings().radarr = [];
    getSettings().sonarr = [];
    const mediaRepo = getRepository(Media);
    await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 91001,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const pending = await seedRequest();

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request/missing').send({
      items: [
        { tmdbId: 91002, mediaType: 'movie' },
        { tmdbId: 91001, mediaType: 'movie' },
        { tmdbId: pending.media.tmdbId, mediaType: 'movie' },
        { tmdbId: 91002, mediaType: 'movie' },
        { tmdbId: 91003, mediaType: 'tv' },
      ],
    });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      res.body.results.map(
        (r: { tmdbId: number; outcome: string; message?: string }) => [
          r.tmdbId,
          r.outcome,
          r.message,
        ]
      ),
      [
        [91002, 'requested', undefined],
        [91001, 'here', undefined],
        [pending.media.tmdbId, 'asked', undefined],
        // A series TMDB lists no seasons for has nothing to request.
        [91003, 'failed', 'There are no seasons to request.'],
      ]
    );
    const made = await getRepository(MediaRequest).find({
      where: { media: { tmdbId: 91002 } },
    });
    assert.strictEqual(made.length, 1);
  });

  it('keeps to the request limit, and says so', async () => {
    getSettings().radarr = [];
    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    friend.movieQuotaLimit = 1;
    friend.movieQuotaDays = 7;
    await userRepo.save(friend);

    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request/missing').send({
      items: [
        { tmdbId: 92001, mediaType: 'movie' },
        { tmdbId: 92002, mediaType: 'movie' },
      ],
    });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      res.body.results.map((r: { outcome: string; message?: string }) => [
        r.outcome,
        r.message,
      ]),
      [
        ['requested', undefined],
        ['failed', 'Your request limit has been reached.'],
      ]
    );
  });

  it('takes at most 20 titles', async () => {
    const agent = await loginAs('friend@seerr.dev', 'test1234');
    const res = await agent.post('/request/missing').send({
      items: Array.from({ length: 21 }, (_, i) => ({
        tmdbId: 93000 + i,
        mediaType: 'movie',
      })),
    });
    assert.strictEqual(res.status, 400);
  });
});

describe('series type and anime', () => {
  const ANIMATION = { id: 16, name: 'Animation' };
  // Japanese animation without TMDB's anime keyword, like Oshi no Ko.
  const JAPANESE_ANIMATION = 88100;
  const KOREAN_ANIMATION = 88101;
  showDetails.set(JAPANESE_ANIMATION, {
    genres: [ANIMATION],
    original_language: 'ja',
  });
  showDetails.set(KOREAN_ANIMATION, {
    genres: [ANIMATION],
    original_language: 'ko',
  });

  async function friendWith(permissions: number) {
    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    friend.permissions = permissions;
    await userRepo.save(friend);
    return loginAs('friend@seerr.dev', 'test1234');
  }

  beforeEach(() => {
    configureSonarr([{ id: 0, isDefault: true, is4k: false }]);
    getSettings().radarr = [];
  });

  it('leaves anime without the keyword to the anime settings, not an ordinary rule', async () => {
    await getRepository(OverrideRule).save(
      new OverrideRule({
        sonarrServiceId: 0,
        genre: '16',
        rootFolder: '/cartoons',
      })
    );
    const agent = await friendWith(Permission.REQUEST);
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: JAPANESE_ANIMATION,
      seasons: [1],
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
    assert.strictEqual(res.body.seriesType, null);
  });

  it("gives a request a rule's series type along with its folder and profile", async () => {
    await getRepository(OverrideRule).save(
      new OverrideRule({
        sonarrServiceId: 0,
        genre: '16',
        language: 'ko|zh',
        rootFolder: '/anime',
        profileId: 7,
        seriesType: 'anime',
      })
    );
    const agent = await friendWith(Permission.REQUEST);
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: KOREAN_ANIMATION,
      seasons: [1],
    });
    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(
      [res.body.rootFolder, res.body.profileId, res.body.seriesType],
      ['/anime', 7, 'anime']
    );
  });

  it('takes anime or not as anyone ticks it, over a rule and the title', async (t) => {
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToSonarr',
      async () => undefined
    );
    await getRepository(OverrideRule).save(
      new OverrideRule({
        sonarrServiceId: 0,
        genre: '16',
        language: 'ko',
        seriesType: 'anime',
      })
    );
    await getRepository(Media).save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: KOREAN_ANIMATION,
        animeSetting: true,
      })
    );

    const agent = await friendWith(Permission.REQUEST);
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: KOREAN_ANIMATION,
      seasons: [1],
      seriesType: 'standard',
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.seriesType, 'standard');

    // Their own edit can change it, and null hands it back.
    let edited = await agent
      .put(`/request/${res.body.id}`)
      .send({ seasons: [1], seriesType: 'anime' });
    assert.strictEqual(edited.status, 200);
    assert.strictEqual(edited.body.seriesType, 'anime');
    edited = await agent
      .put(`/request/${res.body.id}`)
      .send({ seasons: [1], seriesType: null });
    assert.strictEqual(edited.body.seriesType, null);
    // Left out, it stays as it was.
    edited = await agent
      .put(`/request/${res.body.id}`)
      .send({ seasons: [1], seriesType: 'anime' });
    edited = await agent.put(`/request/${res.body.id}`).send({ seasons: [1] });
    assert.strictEqual(edited.body.seriesType, 'anime');
  });

  it("keeps a rule's series type off a title set otherwise", async () => {
    await getRepository(OverrideRule).save(
      new OverrideRule({
        sonarrServiceId: 0,
        genre: '16',
        language: 'ko',
        seriesType: 'anime',
      })
    );
    await getRepository(Media).save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: KOREAN_ANIMATION,
        animeSetting: false,
      })
    );
    const agent = await friendWith(Permission.REQUEST);
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: KOREAN_ANIMATION,
      seasons: [1],
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.seriesType, null);
  });

  it("goes by the title's own anime setting over detection for rules", async () => {
    await getRepository(OverrideRule).save(
      new OverrideRule({
        sonarrServiceId: 0,
        genre: '16',
        rootFolder: '/cartoons',
      })
    );
    await getRepository(Media).save([
      new Media({
        mediaType: MediaType.TV,
        tmdbId: KOREAN_ANIMATION,
        animeSetting: true,
      }),
      new Media({
        mediaType: MediaType.TV,
        tmdbId: JAPANESE_ANIMATION,
        animeSetting: false,
      }),
    ]);
    const agent = await friendWith(Permission.REQUEST);
    // Set as anime: left to the anime settings, not the ordinary rule.
    let res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: KOREAN_ANIMATION,
      seasons: [1],
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
    // Set as not anime: the ordinary rule applies.
    res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: JAPANESE_ANIMATION,
      seasons: [1],
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/cartoons');
  });
});

describe('anime movies', () => {
  const ANIMATION = { id: 16, name: 'Animation' };
  // Japanese animation without TMDB's anime keyword, like Spirited Away.
  const JAPANESE_ANIMATION = 99100;
  const FRENCH_ANIMATION = 99101;
  movieDetails.set(JAPANESE_ANIMATION, {
    genres: [ANIMATION],
    original_language: 'ja',
    release_date: '2001-07-20',
  });
  movieDetails.set(FRENCH_ANIMATION, {
    genres: [ANIMATION],
    original_language: 'fr',
    release_date: '2016-06-29',
  });

  async function friendWith(permissions: number) {
    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    friend.permissions = permissions;
    await userRepo.save(friend);
    return loginAs('friend@seerr.dev', 'test1234');
  }

  beforeEach(() => {
    configureRadarr([
      {
        id: 0,
        isDefault: true,
        is4k: false,
        activeAnimeDirectory: '/anime-movies',
        activeAnimeProfileId: 9,
      },
    ]);
    getSettings().sonarr = [];
  });

  it("gives a movie request a Radarr rule's anime choice", async () => {
    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 0,
        genre: '16',
        language: 'fr',
        seriesType: 'anime',
      })
    );
    const agent = await friendWith(Permission.REQUEST);
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: FRENCH_ANIMATION,
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.seriesType, 'anime');
  });

  it('leaves anime to the anime settings, not an ordinary rule, once the server has them', async () => {
    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 0,
        genre: '16',
        rootFolder: '/cartoons',
      })
    );
    let agent = await friendWith(Permission.REQUEST);
    let res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: JAPANESE_ANIMATION,
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, null);
    await getRepository(MediaRequest).delete({ id: res.body.id });

    // A server with no anime settings goes by its rules, as it always has.
    configureRadarr([{ id: 0, isDefault: true, is4k: false }]);
    agent = await friendWith(Permission.REQUEST);
    res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: JAPANESE_ANIMATION,
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/cartoons');
  });

  it('takes anime or not as anyone ticks it on a movie request', async (t) => {
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );
    const agent = await friendWith(Permission.REQUEST);
    let res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: FRENCH_ANIMATION,
      seriesType: 'anime',
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.seriesType, 'anime');
    // A movie has no daily type.
    res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: JAPANESE_ANIMATION,
      seriesType: 'daily',
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.seriesType, null);
  });

  it('sends anime to Radarr with the anime folder and profile, and the rest as usual', async () => {
    const added: RadarrMovieOptions[] = [];
    Object.defineProperty(RadarrAPI.prototype, 'addMovie', {
      configurable: true,
      set() {},
      get() {
        return async (options: RadarrMovieOptions) => {
          added.push(options);
          return { id: added.length, titleSlug: `movie-${added.length}` };
        };
      },
    });
    configureRadarr([
      {
        id: 0,
        isDefault: true,
        is4k: false,
        tags: [1],
        activeAnimeDirectory: '/anime-movies',
        activeAnimeProfileId: 9,
        animeTags: [4],
      },
    ]);
    const agent = await friendWith(
      Permission.REQUEST | Permission.MANAGE_REQUESTS
    );
    for (const mediaId of [JAPANESE_ANIMATION, FRENCH_ANIMATION]) {
      const res = await agent
        .post('/request')
        .send({ mediaType: MediaType.MOVIE, mediaId });
      assert.strictEqual(res.status, 201);
    }
    assert.deepStrictEqual(
      added.map((a) => [
        a.tmdbId,
        a.rootFolderPath,
        a.qualityProfileId,
        a.tags,
      ]),
      [
        [JAPANESE_ANIMATION, '/anime-movies', 9, [4]],
        [FRENCH_ANIMATION, '/movies', 1, [1]],
      ]
    );
  });

  it('sends a movie as its own anime setting says, over detection', async () => {
    const added: RadarrMovieOptions[] = [];
    Object.defineProperty(RadarrAPI.prototype, 'addMovie', {
      configurable: true,
      set() {},
      get() {
        return async (options: RadarrMovieOptions) => {
          added.push(options);
          return { id: added.length, titleSlug: `movie-${added.length}` };
        };
      },
    });
    await getRepository(Media).save([
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: JAPANESE_ANIMATION,
        animeSetting: false,
      }),
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: FRENCH_ANIMATION,
        animeSetting: true,
      }),
    ]);
    const agent = await friendWith(
      Permission.REQUEST | Permission.MANAGE_REQUESTS
    );
    for (const mediaId of [JAPANESE_ANIMATION, FRENCH_ANIMATION]) {
      const res = await agent
        .post('/request')
        .send({ mediaType: MediaType.MOVIE, mediaId });
      assert.strictEqual(res.status, 201);
    }
    assert.deepStrictEqual(
      added.map((a) => [a.tmdbId, a.rootFolderPath, a.qualityProfileId]),
      [
        [JAPANESE_ANIMATION, '/movies', 1],
        [FRENCH_ANIMATION, '/anime-movies', 9],
      ]
    );
  });
});
