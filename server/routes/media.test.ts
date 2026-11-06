import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaLibraryItem from '@server/entity/MediaLibraryItem';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import libraryAccess from '@server/lib/libraryAccess';
import type { AccessServer } from '@server/lib/libraryAccess/types';
import { Permission } from '@server/lib/permissions';
import { getSettings, jellyfinDefaults } from '@server/lib/settings';
import mediaRoutes from '@server/routes/media';
import movieRoutes from '@server/routes/movie';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Recently Added and title pages for someone whose Plex libraries don't hold
 * every title, with "Show people only what their libraries hold" on, through
 * the real routes and OpenAPI validator.
 */

setupTestDb();

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async ({ movieId }: { movieId: number }) => ({
      id: movieId,
      title: 'Film',
      overview: 'A film.',
      genres: [],
      production_companies: [],
      production_countries: [],
      spoken_languages: [],
      release_dates: { results: [] },
      credits: { cast: [], crew: [] },
      external_ids: {},
      videos: { results: [] },
      keywords: { keywords: [] },
      'watch/providers': { results: {} },
    });
  },
});

let server: Server;
let port: number;
let actingAs: User;

const get = <T>(route: string) =>
  new Promise<{ status: number; body: T }>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: route }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) })
        );
      })
      .on('error', reject);
  });

const fakeServer = (): AccessServer => ({
  canGiveAll: false,
  async read() {
    return {
      libraries: [
        { id: '9001', title: 'Family Films', type: 'movie' },
        { id: '9002', title: 'Films', type: 'movie' },
      ],
      people: [
        { id: '501', name: 'kid', ref: '1', all: false, libraries: ['9001'] },
      ],
      scanIds: new Map([
        ['9001', '1'],
        ['9002', '2'],
      ]),
    };
  },
  async write() {},
});

let member: User;
let admin: User;

beforeEach(async () => {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.main.limitToLibraries = true;
  settings.plex = { ...settings.plex, machineId: 'machine-1', webAppUrl: '' };
  settings.jellyfin = { ...jellyfinDefaults(), connected: false };
  settings.emby = { ...jellyfinDefaults(), connected: false };
  cacheManager.getCache('libraryaccess').flush();
  mock.method(libraryAccess, 'server', async () => fakeServer());

  admin = await getRepository(User).save(
    new User({
      email: 'films-admin@example.invalid',
      permissions: Permission.ADMIN,
      avatar: '',
    })
  );
  member = await getRepository(User).save(
    new User({
      email: 'films-kid@example.invalid',
      permissions: Permission.REQUEST,
      plexId: 501,
      avatar: '',
    })
  );
  actingAs = member;

  // Glasswing in the family library, Static Garden only in the other.
  const added = new Date('2026-10-01T10:00:00Z').getTime();
  for (const [i, [tmdbId, library]] of (
    [
      [9301, '1'],
      [9302, '2'],
    ] as const
  ).entries()) {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        ratingKey: `k-${tmdbId}`,
        mediaAddedAt: new Date(added + i * 60000),
      })
    );
    await getRepository(MediaLibraryItem).save(
      new MediaLibraryItem({
        mediaId: media.id,
        server: 'plex',
        libraryId: library,
        is4k: false,
        itemId: `k-${tmdbId}`,
      })
    );
  }

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
    app.use('/api/v1/movie', movieRoutes);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = (server.address() as { port: number }).port;
  }
});

afterEach(() => {
  mock.restoreAll();
  getSettings().main.limitToLibraries = false;
});

after(() => server?.close());

type Page = {
  pageInfo: { results: number };
  results: { tmdbId: number; status: number; outsideLibraries?: boolean }[];
};

const recentlyAdded = async () =>
  (await get<Page>('/api/v1/media?filter=allavailable&take=20&sort=mediaAdded'))
    .body;

describe('Recently Added', () => {
  it('leaves out titles only in libraries the viewer cannot open', async () => {
    const page = await recentlyAdded();
    assert.deepEqual(
      page.results.map((m) => m.tmdbId),
      [9301]
    );
    assert.equal(page.pageInfo.results, 1);
  });

  it('shows everything to admins', async () => {
    actingAs = admin;
    const page = await recentlyAdded();
    assert.deepEqual(
      page.results.map((m) => m.tmdbId),
      [9302, 9301]
    );
  });

  it('shows everything with the setting off', async () => {
    getSettings().main.limitToLibraries = false;
    const page = await recentlyAdded();
    assert.deepEqual(
      page.results.map((m) => m.tmdbId),
      [9302, 9301]
    );
  });

  it('shows everything when the viewer’s libraries cannot be read', async () => {
    mock.restoreAll();
    mock.method(libraryAccess, 'server', async () => {
      throw new Error('plex.tv did not answer');
    });
    const page = await recentlyAdded();
    assert.deepEqual(
      page.results.map((m) => m.tmdbId),
      [9302, 9301]
    );
  });
});

describe('a title page', () => {
  type Details = {
    mediaInfo: {
      status: number;
      outsideLibraries?: boolean;
      playLinks: unknown[];
    };
  };

  it('shows a title in a library the viewer cannot open as not available, without a play link', async () => {
    const { status, body } = await get<Details>('/api/v1/movie/9302');
    assert.equal(status, 200);
    assert.equal(body.mediaInfo.status, MediaStatus.UNKNOWN);
    assert.equal(body.mediaInfo.outsideLibraries, true);
    assert.deepEqual(body.mediaInfo.playLinks, []);
  });

  it('shows a title in the viewer’s library as available, with its play link', async () => {
    const { body } = await get<Details>('/api/v1/movie/9301');
    assert.equal(body.mediaInfo.status, MediaStatus.AVAILABLE);
    assert.equal(body.mediaInfo.outsideLibraries, undefined);
    assert.equal(body.mediaInfo.playLinks.length, 1);
  });
});
