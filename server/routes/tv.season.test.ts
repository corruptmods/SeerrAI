import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import EpisodeRequest from '@server/entity/EpisodeRequest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import tvRoutes from '@server/routes/tv';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

/*
 * The season endpoint reports which episodes active requests already cover,
 * so the series page never offers Request for one that is on its way.
 */

setupTestDb();

const TV_ID = 4000;

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  configurable: true,
  set() {},
  get() {
    return async () => ({ id: TV_ID, keywords: { results: [] } });
  },
});

Object.defineProperty(TheMovieDb.prototype, 'getTvSeason', {
  configurable: true,
  set() {},
  get() {
    return async ({ seasonNumber }: { seasonNumber: number }) => ({
      id: 9000 + seasonNumber,
      air_date: '2020-01-01',
      name: `Season ${seasonNumber}`,
      overview: '',
      poster_path: null,
      season_number: seasonNumber,
      external_ids: {},
      episodes: [1, 2, 3, 4].map((n) => ({
        id: seasonNumber * 100 + n,
        air_date: '2020-01-01',
        episode_number: n,
        name: `Episode ${n}`,
        overview: '',
        production_code: '',
        season_number: seasonNumber,
        show_id: TV_ID,
        still_path: null,
        vote_average: 0,
        vote_count: 0,
      })),
    });
  },
});

let server: Server;
let port: number;
let requester: User;

const season = async (n: number) =>
  new Promise<
    { episodeNumber: number; requested?: boolean; requested4k?: boolean }[]
  >((resolve, reject) => {
    http
      .get(
        { host: '127.0.0.1', port, path: `/api/v1/tv/${TV_ID}/season/${n}` },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(raw).episodes);
            } catch {
              reject(new Error(`${res.statusCode}: ${raw.slice(0, 200)}`));
            }
          });
        }
      )
      .on('error', reject);
  });

const request = async (
  media: Media,
  status: MediaRequestStatus,
  seasonNumber: number,
  episodes: number[] = [],
  is4k = false
) =>
  getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.TV,
      media,
      requestedBy: requester,
      status,
      is4k,
      seasons: [
        new SeasonRequest({
          seasonNumber,
          status,
          episodes: episodes.map(
            (episodeNumber) => new EpisodeRequest({ episodeNumber })
          ),
        }),
      ],
    })
  );

const flags = (
  eps: { episodeNumber: number; requested?: boolean; requested4k?: boolean }[]
) =>
  eps
    .map(
      (e) =>
        `${e.episodeNumber}:${e.requested ? 'R' : '-'}${e.requested4k ? '4' : '-'}`
    )
    .join(' ');

beforeEach(async () => {
  await getRepository(User).save(
    new User({
      email: 'tv-req@test.local',
      plexUsername: 'tv-req',
      permissions: Permission.REQUEST,
      avatar: '',
    })
  );
  requester = await getRepository(User).findOneOrFail({
    where: { plexUsername: 'tv-req' },
  });

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
    app.use('/api/v1/tv', tvRoutes);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    port = (server.address() as { port: number }).port;
  }
});

after(() => server?.close());

describe('episodes already requested, on the season endpoint', () => {
  it('reports nothing requested for a title nobody has asked for', async () => {
    assert.equal(flags(await season(1)), '1:-- 2:-- 3:-- 4:--');
  });

  it('counts a whole-season request for every episode, and only that season', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: TV_ID,
        mediaType: MediaType.TV,
        status: MediaStatus.PENDING,
      })
    );
    await request(media, MediaRequestStatus.PENDING, 1);
    assert.equal(flags(await season(1)), '1:R- 2:R- 3:R- 4:R-');
    assert.equal(flags(await season(2)), '1:-- 2:-- 3:-- 4:--');
  });

  it('counts only the episodes an episode request names', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: TV_ID,
        mediaType: MediaType.TV,
        status: MediaStatus.PENDING,
      })
    );
    await request(media, MediaRequestStatus.APPROVED, 2, [2, 4]);
    assert.equal(flags(await season(2)), '1:-- 2:R- 3:-- 4:R-');
  });

  it('ignores declined and completed requests', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: TV_ID,
        mediaType: MediaType.TV,
        status: MediaStatus.UNKNOWN,
      })
    );
    await request(media, MediaRequestStatus.DECLINED, 1);
    await request(media, MediaRequestStatus.COMPLETED, 1, [3]);
    assert.equal(flags(await season(1)), '1:-- 2:-- 3:-- 4:--');
  });

  it('keeps 4K separate', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: TV_ID,
        mediaType: MediaType.TV,
        status: MediaStatus.UNKNOWN,
      })
    );
    await request(media, MediaRequestStatus.PENDING, 1, [1], true);
    assert.equal(flags(await season(1)), '1:-4 2:-- 3:-- 4:--');
  });
});
