import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import FutureSeasonSubscription from '@server/entity/FutureSeasonSubscription';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import futureSeasons from '@server/lib/futureSeasons';
import { Permission } from '@server/lib/permissions';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/*
 * Following a series, through the real request path rather than a stub:
 * Seerr refuses a second automatic request for the same title and person,
 * which once meant only the first new season was ever asked for.
 */

setupTestDb();

const NOW = Date.parse('2026-09-26T12:00:00Z');
const DAY = 86_400_000;
const date = (days: number) =>
  new Date(NOW + days * DAY).toISOString().slice(0, 10);

let seasons: {
  season_number: number;
  air_date: string | null;
  episode_count: number;
}[];

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  configurable: true,
  set() {},
  get() {
    return async ({ tvId }: { tvId: number }) => ({
      id: tvId,
      name: 'Followed Series',
      status: 'Returning Series',
      first_air_date: date(-700),
      seasons,
      external_ids: { tvdb_id: 999 },
    });
  },
});

const requestedSeasons = async () =>
  (await getRepository(MediaRequest).find({ relations: { seasons: true } }))
    .flatMap((r) => r.seasons.map((s) => s.seasonNumber))
    .sort((a, b) => a - b);

const follower = () =>
  getRepository(User).save(
    new User({
      email: 'follower@test.local',
      plexUsername: 'follower',
      permissions: Permission.REQUEST | Permission.AUTO_APPROVE,
      avatar: '',
    })
  );

describe('following a series', () => {
  beforeEach(() => {
    seasons = [
      { season_number: 1, air_date: date(-700), episode_count: 8 },
      { season_number: 2, air_date: date(-300), episode_count: 8 },
      { season_number: 3, air_date: date(30), episode_count: 8 },
    ];
  });

  it('asks for every new season as it starts, not just the first', async () => {
    const user = await follower();
    await getRepository(FutureSeasonSubscription).save(
      new FutureSeasonSubscription({ user, tmdbId: 500, fromSeason: 3 })
    );

    seasons[2].air_date = date(0);
    await futureSeasons.run(NOW);
    assert.deepEqual(await requestedSeasons(), [3]);

    seasons.push({ season_number: 4, air_date: date(365), episode_count: 8 });
    await futureSeasons.run(NOW + 365 * DAY);
    assert.deepEqual(await requestedSeasons(), [3, 4]);

    const [subscription] = await getRepository(FutureSeasonSubscription).find();
    assert.equal(subscription.fromSeason, 5);
  });

  it('is not stopped by an earlier watchlist request for the series', async () => {
    const user = await follower();
    // The watchlist sync asked for the first two seasons automatically.
    await MediaRequest.request(
      { mediaId: 500, mediaType: MediaType.TV, tvdbId: 999, seasons: [1, 2] },
      user,
      { isAutoRequest: true }
    );
    await getRepository(FutureSeasonSubscription).save(
      new FutureSeasonSubscription({ user, tmdbId: 500, fromSeason: 3 })
    );

    seasons[2].air_date = date(0);
    await futureSeasons.run(NOW);
    assert.deepEqual(await requestedSeasons(), [1, 2, 3]);
  });

  it('still keeps an automatic request from repeating itself', async () => {
    const user = await follower();
    const body = {
      mediaId: 500,
      mediaType: MediaType.TV,
      tvdbId: 999,
      seasons: [1],
    };
    await MediaRequest.request(body, user, { isAutoRequest: true });
    await assert.rejects(
      MediaRequest.request({ ...body, seasons: [2] }, user, {
        isAutoRequest: true,
      }),
      /Auto-request for this media and user already exists/
    );
  });
});
