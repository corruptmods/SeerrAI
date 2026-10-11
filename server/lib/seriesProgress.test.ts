import type { TautulliHistoryRecord } from '@server/api/tautulli';
import TautulliAPI from '@server/api/tautulli';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Episode from '@server/entity/Episode';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import type { EpisodeRef } from '@server/lib/seriesProgress';
import { getSeriesProgress, workOutProgress } from '@server/lib/seriesProgress';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const ep = (season: number, episode: number): EpisodeRef => ({
  season,
  episode,
});

describe('working out where someone is in a series', () => {
  const library = [ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1), ep(2, 2)];

  it('points at the next episode and counts what is left', () => {
    assert.deepEqual(workOutProgress([ep(1, 1), ep(1, 2)], library), {
      state: 'up_next',
      next: ep(1, 3),
      remaining: 3,
      furthest: ep(1, 2),
    });
  });

  it('uses the furthest episode finished, not the most recent', () => {
    // Finished season two, then rewatched an early episode.
    assert.deepEqual(workOutProgress([ep(2, 1), ep(1, 1)], library), {
      state: 'up_next',
      next: ep(2, 2),
      remaining: 1,
      furthest: ep(2, 1),
    });
  });

  it('is caught up once past everything in the library', () => {
    assert.deepEqual(workOutProgress([ep(2, 2)], library), {
      state: 'caught_up',
      remaining: 0,
      furthest: ep(2, 2),
    });
  });

  it('has not started when nothing is finished', () => {
    assert.deepEqual(workOutProgress([], library), {
      state: 'not_started',
      next: ep(1, 1),
      remaining: 5,
    });
  });

  it('ignores specials on both sides', () => {
    assert.deepEqual(workOutProgress([ep(0, 1)], [ep(0, 1), ...library]), {
      state: 'not_started',
      next: ep(1, 1),
      remaining: 5,
    });
  });

  it('says nothing when none of the series is in the library', () => {
    assert.equal(workOutProgress([ep(1, 1)], []), null);
  });
});

describe('series progress from Tautulli', () => {
  setupTestDb();

  let plays: Partial<TautulliHistoryRecord>[] = [];
  let tautulliDown = false;
  let viewer: User;
  let ratingKeyCounter = 0;

  Object.defineProperty(TautulliAPI.prototype, 'getUserPlaysSince', {
    configurable: true,
    set() {},
    get() {
      return async (_user: User, options: { strict?: boolean }) => {
        if (tautulliDown) {
          if (options.strict) {
            throw new Error('Tautulli is down');
          }

          return [];
        }

        return plays;
      };
    },
  });

  const finished = (season: number, episode: number, percent = 100) => ({
    media_type: 'episode',
    parent_media_index: season,
    media_index: episode,
    watched_status: percent >= 90 ? 1 : 0,
    percent_complete: percent,
    date: 1_700_000_000,
  });

  /** A series with seasons one and two in the library, plus a special. */
  const seedSeries = async (tmdbId: number) => {
    // Each test gets its own Plex id, so no cached position carries over.
    const ratingKey = `rk-${tmdbId}-${++ratingKeyCounter}`;
    const media = await getRepository(Media).save(
      new Media({
        tmdbId,
        mediaType: MediaType.TV,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        ratingKey,
      })
    );

    for (const [seasonNumber, count] of [
      [0, 1],
      [1, 3],
      [2, 2],
    ]) {
      const season = await getRepository(Season).save(
        new Season({
          seasonNumber,
          status: MediaStatus.AVAILABLE,
          media: Promise.resolve(media),
        } as never)
      );

      for (let n = 1; n <= count; n++) {
        await getRepository(Episode).save(
          new Episode({
            episodeNumber: n,
            status: MediaStatus.AVAILABLE,
            season: Promise.resolve(season),
          } as never)
        );
      }
    }

    return media;
  };

  beforeEach(async () => {
    plays = [];
    tautulliDown = false;
    getSettings().tautulli = {
      hostname: 'tautulli.invalid',
      port: 8181,
      apiKey: 'x',
      useSsl: false,
      urlBase: '',
    } as never;

    await getRepository(User).save(
      new User({
        email: 'viewer@test.local',
        plexUsername: 'viewer',
        plexId: 4242,
        permissions: Permission.REQUEST,
        avatar: '',
      })
    );
    viewer = await getRepository(User).findOneOrFail({
      where: { plexUsername: 'viewer' },
    });
  });

  it('reports the next episode from real library rows', async () => {
    await seedSeries(500);
    plays = [finished(1, 1), finished(1, 2)];

    const result = await getSeriesProgress(viewer, [500]);

    assert.deepEqual(result[500], {
      state: 'up_next',
      next: ep(1, 3),
      remaining: 3,
      furthest: ep(1, 2),
    });
  });

  it('does not count a play that was abandoned', async () => {
    await seedSeries(501);
    plays = [finished(1, 1), finished(1, 2, 40)];

    const result = await getSeriesProgress(viewer, [501]);

    assert.deepEqual(result[501]?.next, ep(1, 2));
  });

  it('leaves a series out when Tautulli cannot be asked', async () => {
    await seedSeries(502);
    tautulliDown = true;

    const result = await getSeriesProgress(viewer, [502]);

    assert.equal(
      result[502],
      undefined,
      'an outage must not read as "not started"'
    );
  });

  it('answers nothing for a viewer without a Plex account', async () => {
    await seedSeries(503);
    viewer.plexId = undefined;

    assert.deepEqual(await getSeriesProgress(viewer, [503]), {});
  });

  it('answers nothing when Tautulli is not configured', async () => {
    await seedSeries(504);
    // The settings setter merges, so the fields have to be cleared explicitly.
    getSettings().tautulli = { hostname: '', apiKey: '' } as never;

    assert.deepEqual(await getSeriesProgress(viewer, [504]), {});
  });
});
