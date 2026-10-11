import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import mediaRoutes from '@server/routes/media';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * "Watched by" on a title, from a fake Tautulli's history, behind the real
 * API validator.
 */

setupTestDb();

const DAY = 24 * 60 * 60;
const now = Math.floor(Date.now() / 1000);
// History as Tautulli's get_history gives it, keyed by what was asked for.
let history: Record<string, unknown[]> = {};
let asked: string[] = [];
const fake = http.createServer((req, res) => {
  const url = new URL(req.url ?? '', 'http://x');
  const key = url.searchParams.get('rating_key')
    ? `movie:${url.searchParams.get('rating_key')}`
    : `show:${url.searchParams.get('grandparent_rating_key')}`;
  asked.push(`${url.searchParams.get('cmd')} ${key}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      response: { result: 'success', data: { data: history[key] ?? [] } },
    })
  );
});
let app: Server;
let port: number;
let actingAs: User;
let admin: User;
let jordan: User;

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  const ex = express();
  ex.use(express.json());
  ex.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  ex.use((req, _res, next) => {
    (req as unknown as { user: User }).user = actingAs;
    next();
  });
  ex.use('/api/v1/media', mediaRoutes);
  app = await new Promise<Server>((resolve) => {
    const s = ex.listen(0, () => resolve(s));
  });
  port = (app.address() as { port: number }).port;
});
after(() => {
  app?.close();
  fake.close();
});

beforeEach(async () => {
  history = {};
  asked = [];
  getSettings().tautulli = {
    hostname: '127.0.0.1',
    port: (fake.address() as { port: number }).port,
    apiKey: 'k',
    useSsl: false,
  };
  admin = await getRepository(User).save(
    new User({
      email: 'wb-admin@test.local',
      plexUsername: 'Alex',
      plexId: 1,
      permissions: Permission.ADMIN,
      avatar: '/a.png',
    })
  );
  jordan = await getRepository(User).save(
    new User({
      email: 'wb-k@test.local',
      plexUsername: 'Jordan',
      plexId: 2,
      permissions: Permission.REQUEST,
      avatar: '/k.png',
    })
  );
  actingAs = admin;
});

const play = (
  user: number,
  name: string,
  ratingKey: number,
  daysAgo: number,
  watched = 1
) => ({
  user_id: user,
  friendly_name: name,
  rating_key: ratingKey,
  date: now - daysAgo * DAY,
  watched_status: watched,
});

const watchedBy = (mediaId: number) =>
  new Promise<{
    status: number;
    body: {
      configured: boolean;
      people: {
        name: string;
        user?: { id: number };
        count: number;
        lastWatched: string;
      }[];
    };
  }>((resolve, reject) => {
    http
      .get(
        {
          host: '127.0.0.1',
          port,
          path: `/api/v1/media/${mediaId}/watched-by`,
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            let body = { configured: false, people: [] };
            try {
              body = JSON.parse(raw);
            } catch {
              // An error page: the status is what matters.
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        }
      )
      .on('error', reject);
  });

describe('watched by', () => {
  it('lists who finished a film, most recent first, counting both copies', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 1,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        ratingKey: '100',
        ratingKey4k: '200',
      })
    );
    history = {
      'movie:100': [
        play(2, 'jordan', 100, 3),
        play(1, 'alex', 100, 40),
        play(2, 'jordan', 100, 1, 0),
      ],
      'movie:200': [play(1, 'alex', 200, 10), play(9, 'Guest', 200, 20)],
    };
    const { status, body } = await watchedBy(media.id);
    assert.equal(status, 200);
    assert.deepEqual(
      body.people.map((p) => [
        p.name,
        p.user?.id ?? null,
        p.count,
        Math.round(
          (Date.now() - new Date(p.lastWatched).getTime()) / (DAY * 1000)
        ),
      ]),
      [
        ['Jordan', jordan.id, 1, 3],
        ['Alex', admin.id, 2, 10],
        ['Guest', null, 1, 20],
      ],
      'the unfinished play a day ago does not count; a Plex account with no Seerr user keeps its Plex name'
    );
    assert.deepEqual(asked.sort(), [
      'get_history movie:100',
      'get_history movie:200',
    ]);
  });

  it('counts episodes finished for a series, not plays', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 2,
        mediaType: MediaType.TV,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        ratingKey: '300',
      })
    );
    history = {
      'show:300': [
        play(2, 'jordan', 301, 1),
        play(2, 'jordan', 302, 2),
        play(2, 'jordan', 301, 5),
      ],
    };
    const { body } = await watchedBy(media.id);
    assert.deepEqual(
      body.people.map((p) => [p.name, p.count]),
      [['Jordan', 2]],
      'episode 301 watched twice counts once'
    );
  });

  it('says when Tautulli is not set up, and is for admins only', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 3,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        ratingKey: '400',
      })
    );
    // The setting merges rather than replaces, so clear the fields.
    getSettings().tautulli = { hostname: '', port: 0, apiKey: '' };
    assert.deepEqual((await watchedBy(media.id)).body, {
      configured: false,
      people: [],
    });
    actingAs = jordan;
    assert.equal((await watchedBy(media.id)).status, 403);
  });
});
