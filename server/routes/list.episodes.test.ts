import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Episode from '@server/entity/Episode';
import Media from '@server/entity/Media';
import { MediaList, MediaListItem } from '@server/entity/MediaList';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import listRoutes from '@server/routes/list';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import { after, beforeEach, describe, it } from 'node:test';

const stub = (name: string, fn: (a: never) => unknown) =>
  Object.defineProperty(TheMovieDb.prototype, name, {
    configurable: true,
    set() {},
    get() {
      return async (a: never) => fn(a);
    },
  });

describe('episode progress on list items', () => {
  setupTestDb();
  let server: Server;
  let port: number;
  let owner: User;

  const get = <T>(path: string) =>
    new Promise<T>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path }, (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(raw));
            } catch (e) {
              reject(e);
            }
          });
        })
        .on('error', reject);
    });

  beforeEach(async () => {
    stub('getMovie', () => ({ id: 1, title: 'M', poster_path: '/m.jpg' }));
    stub('getTvShow', () => ({
      id: 1,
      name: 'S',
      poster_path: '/t.jpg',
      first_air_date: '2026-01-01',
      seasons: [
        { season_number: 0, episode_count: 3 },
        { season_number: 1, episode_count: 8 },
        { season_number: 2, episode_count: 5 },
      ],
    }));
    await getRepository(User).save(
      new User({
        email: 'ep@test.local',
        plexUsername: 'ep-owner',
        permissions: Permission.ADMIN,
        avatar: '',
      })
    );
    owner = await getRepository(User).findOneOrFail({
      where: { plexUsername: 'ep-owner' },
    });
    if (!server) {
      const app = express();
      app.use(express.json());
      app.use((req, _r, n) => {
        (req as unknown as { user: User }).user = owner;
        n();
      });
      app.use('/api/v1/list', listRoutes);
      server = await new Promise<Server>((r) => {
        const s = app.listen(0, () => r(s));
      });
      port = (server.address() as { port: number }).port;
    }
  });
  after(() => server?.close());

  it('counts available episodes across seasons, excluding specials', async () => {
    const list = await getRepository(MediaList).save(
      new MediaList({ name: 'L', ownerId: owner.id })
    );
    await getRepository(MediaListItem).save(
      new MediaListItem({ listId: list.id, tmdbId: 99, mediaType: 'tv' })
    );
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 99,
        mediaType: MediaType.TV,
        status: MediaStatus.PARTIALLY_AVAILABLE,
      })
    );
    const specials = await getRepository(Season).save(
      new Season({
        seasonNumber: 0,
        status: MediaStatus.AVAILABLE,
        media: Promise.resolve(media),
      } as never)
    );
    const s1 = await getRepository(Season).save(
      new Season({
        seasonNumber: 1,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        media: Promise.resolve(media),
      } as never)
    );
    const s2 = await getRepository(Season).save(
      new Season({
        seasonNumber: 2,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        media: Promise.resolve(media),
      } as never)
    );
    for (let e = 1; e <= 3; e++)
      await getRepository(Episode).save(
        new Episode({
          episodeNumber: e,
          status: MediaStatus.AVAILABLE,
          season: Promise.resolve(specials),
        } as never)
      );
    for (let e = 1; e <= 8; e++)
      await getRepository(Episode).save(
        new Episode({
          episodeNumber: e,
          status: e <= 5 ? MediaStatus.AVAILABLE : MediaStatus.UNKNOWN,
          season: Promise.resolve(s1),
        } as never)
      );
    for (let e = 1; e <= 5; e++)
      await getRepository(Episode).save(
        new Episode({
          episodeNumber: e,
          status: e <= 2 ? MediaStatus.AVAILABLE : MediaStatus.UNKNOWN,
          season: Promise.resolve(s2),
        } as never)
      );

    const body = await get<{
      items: { availableEpisodes?: number; totalEpisodes?: number }[];
    }>(`/api/v1/list/${list.id}`);
    const item = body.items[0];
    assert.equal(
      item.availableEpisodes,
      7,
      '5 from season 1 + 2 from season 2, specials excluded'
    );
    assert.equal(item.totalEpisodes, 13, '8 + 5, specials excluded');
  });
});
