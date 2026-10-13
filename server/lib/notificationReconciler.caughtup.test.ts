import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Episode from '@server/entity/Episode';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { MediaRequestWatcher } from '@server/entity/MediaRequestWatcher';
import NotificationDelivery from '@server/entity/NotificationDelivery';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import notificationReconciler from '@server/lib/notificationReconciler';
import { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const stubTmdb = () => {
  const stub = (name: string, value: unknown) =>
    Object.defineProperty(TheMovieDb.prototype, name, {
      configurable: true,
      set() {},
      get() {
        return async () => value;
      },
    });

  stub('getMovie', { id: 1, title: 'M', release_date: '2026-01-01' });
  stub('getTvShow', {
    id: 1,
    name: 'Ongoing Series',
    first_air_date: '2026-01-01',
    seasons: [{ season_number: 1, episode_count: 8 }],
  });
};

/**
 * Season detail with air dates. Three episodes aired before the request, the
 * rest after — so the requester should hear once those three are downloaded,
 * and not again when episode four lands later.
 */
const stubSeason = (airDates: string[]) =>
  Object.defineProperty(TheMovieDb.prototype, 'getTvSeason', {
    configurable: true,
    set() {},
    get() {
      return async () => ({
        episodes: airDates.map((air_date, index) => ({
          episode_number: index + 1,
          air_date,
        })),
      });
    },
  });

// Relative to the request, which the harness creates as "now". Fixed dates
// would silently drift into the past and stop testing the distinction.
const daysFromNow = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const BEFORE_REQUEST = [daysFromNow(-60), daysFromNow(-30), daysFromNow(-7)];
const AFTER_REQUEST = [daysFromNow(7), daysFromNow(14)];

/**
 * An ongoing series arrives week by week, so it sits at partially available
 * and never triggers the "now available" notification. The requester should
 * still hear when the first episodes land, and again as more arrive — but only
 * once per milestone.
 */
/**
 * Only the caught-up notification is under test. Creating the request in
 * setup also fires an auto-approval notification, and that one is
 * fire-and-forget — on a slower database it can land after setup has cleared
 * the list, inside the test itself. Counting every notification made these
 * tests flaky on Postgres; counting only the one being tested does not.
 */
let sent: number[] = [];
/** Everything each send was given, for the watcher's copy. */
let calls: Parameters<typeof MediaRequest.sendNotification>[] = [];

const caughtUp = () =>
  sent.filter((type) => type === Notification.MEDIA_AVAILABLE);

describe('series caught-up notifications', () => {
  setupTestDb();

  let media: Media;
  let season: Season;

  const addEpisodes = async (count: number, status: MediaStatus) => {
    const existing = await getRepository(Episode).countBy({});

    for (let i = 0; i < count; i++) {
      await getRepository(Episode).save(
        new Episode({
          episodeNumber: existing + i + 1,
          status,
          season: Promise.resolve(season),
        } as never)
      );
    }
  };

  beforeEach(async () => {
    stubTmdb();
    stubSeason([...BEFORE_REQUEST, ...AFTER_REQUEST]);
    sent = [];
    calls = [];

    // Record what the reconciler decides to send, without going near a real
    // notification agent.
    Object.defineProperty(MediaRequest, 'sendNotification', {
      configurable: true,
      value: async (
        ...args: Parameters<typeof MediaRequest.sendNotification>
      ) => {
        sent.push(args[2]);
        calls.push(args);

        return true;
      },
    });

    await getRepository(User).save(
      new User({
        email: 'partial@test.local',
        plexUsername: 'partial-user',
        permissions: Permission.REQUEST,
        avatar: '',
      })
    );
    const user = await getRepository(User).findOneOrFail({
      where: { plexUsername: 'partial-user' },
    });

    media = await getRepository(Media).save(
      new Media({
        tmdbId: 80001,
        mediaType: MediaType.TV,
        status: MediaStatus.PARTIALLY_AVAILABLE,
      })
    );

    season = await getRepository(Season).save(
      new Season({
        seasonNumber: 1,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        media: Promise.resolve(media),
      } as never)
    );

    await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        requestedBy: user,
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        is4k: false,
      })
    );

    sent = [];
  });

  it('notifies once everything aired by request time is available', async () => {
    await addEpisodes(3, MediaStatus.AVAILABLE);

    await notificationReconciler.run();

    assert.equal(
      caughtUp().length,
      1,
      'the requester can now watch it up to date'
    );
  });

  it('tells a watcher in the same words, about the same request', async () => {
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { media: { id: media.id } },
    });
    const watcher = await getRepository(User).save(
      new User({
        email: 'partial-watcher@test.local',
        plexUsername: 'partial-watcher',
        permissions: Permission.REQUEST,
        avatar: '',
      })
    );
    await getRepository(MediaRequestWatcher).save(
      new MediaRequestWatcher({ requestId: request.id, userId: watcher.id })
    );
    await addEpisodes(3, MediaStatus.AVAILABLE);

    await notificationReconciler.run();

    const ready = calls.filter((c) => c[2] === Notification.MEDIA_AVAILABLE);
    assert.equal(ready.length, 2, 'the requester, then the watcher');
    const [, toWatcher] = ready;
    assert.equal(toWatcher[0].requestedBy.id, request.requestedBy.id);
    assert.equal(toWatcher[3], 'Series Ready to Watch');
    assert.deepEqual(toWatcher[4], ready[0][4]);
    // Sent to the watcher alone, not dressed up as their own request.
    assert.equal(toWatcher[5]?.id, watcher.id);
  });

  it('says nothing while an already-aired episode is still missing', async () => {
    await addEpisodes(2, MediaStatus.AVAILABLE);

    await notificationReconciler.run();

    assert.deepEqual(
      caughtUp(),
      [],
      'two of the three aired episodes is not caught up'
    );
  });

  it('does not notify again when later episodes air and arrive', async () => {
    await addEpisodes(3, MediaStatus.AVAILABLE);
    await notificationReconciler.run();
    sent = [];

    // Episodes four and five air weeks later and are downloaded.
    await addEpisodes(2, MediaStatus.AVAILABLE);
    await notificationReconciler.run();
    await notificationReconciler.run();

    assert.deepEqual(
      caughtUp(),
      [],
      'the catch-up moment is announced only once'
    );
  });

  it('survives a request whose media row has gone', async () => {
    // Reproduces "Cannot read properties of null (reading 'id')": the media is
    // removed from the library while the request stays behind, which is how
    // the row ends up orphaned in practice.
    const doomed = await getRepository(Media).save(
      new Media({
        tmdbId: 80002,
        mediaType: MediaType.TV,
        status: MediaStatus.PARTIALLY_AVAILABLE,
      })
    );

    await getRepository(MediaRequest).save(
      new MediaRequest({
        media: doomed,
        requestedBy: await getRepository(User).findOneOrFail({
          where: { plexUsername: 'partial-user' },
        }),
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        is4k: false,
      })
    );

    await getRepository(Media).delete({ id: doomed.id });
    await addEpisodes(3, MediaStatus.AVAILABLE);
    sent = [];

    // Must not throw, and must still notify the healthy request.
    await notificationReconciler.run();

    assert.equal(
      caughtUp().length,
      1,
      'one orphaned row must not stop the pass'
    );
  });

  it('says nothing while no episode is playable yet', async () => {
    await addEpisodes(3, MediaStatus.PROCESSING);

    await notificationReconciler.run();

    assert.deepEqual(caughtUp(), []);
  });

  it('stays quiet when the air dates cannot be read', async () => {
    Object.defineProperty(TheMovieDb.prototype, 'getTvSeason', {
      configurable: true,
      set() {},
      get() {
        return async () => {
          throw new Error('TMDB unavailable');
        };
      },
    });

    await addEpisodes(3, MediaStatus.AVAILABLE);
    await notificationReconciler.run();

    assert.deepEqual(
      caughtUp(),
      [],
      'without air dates the comparison is meaningless'
    );
  });

  it('ignores specials when judging whether it is caught up', async () => {
    const specials = await getRepository(Season).save(
      new Season({
        seasonNumber: 0,
        status: MediaStatus.AVAILABLE,
        media: Promise.resolve(media),
      } as never)
    );

    await getRepository(Episode).save(
      new Episode({
        episodeNumber: 1,
        status: MediaStatus.AVAILABLE,
        season: Promise.resolve(specials),
      } as never)
    );

    await notificationReconciler.run();

    assert.deepEqual(
      caughtUp(),
      [],
      'a special is not part of the run of the show'
    );
  });
  it('leaves a finished series to the ordinary notification', async () => {
    // Reproduces a double notification: every requested episode had aired,
    // all were downloaded, and the title had not yet been marked available.
    // "Ready to watch" went out, then "now available" five minutes later.
    stubSeason(BEFORE_REQUEST);
    await addEpisodes(3, MediaStatus.AVAILABLE);

    await notificationReconciler.run();

    assert.deepEqual(
      caughtUp(),
      [],
      'nothing left to air, so "now available" is the one to send'
    );
  });

  it('says nothing once the request was announced as available', async () => {
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { media: { id: media.id } },
    });
    await getRepository(NotificationDelivery).insert({
      requestId: request.id,
      type: Notification.MEDIA_AVAILABLE,
      userId: 0,
      episodeKey: '',
    });
    await addEpisodes(3, MediaStatus.AVAILABLE);

    await notificationReconciler.run();

    assert.deepEqual(caughtUp(), []);
  });

  it('judges only the seasons that were requested', async () => {
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { media: { id: media.id } },
    });
    await getRepository(SeasonRequest).save(
      new SeasonRequest({
        seasonNumber: 1,
        status: MediaRequestStatus.APPROVED,
        request,
      })
    );
    // An earlier season nobody asked for, with nothing downloaded.
    await getRepository(Season).save(
      new Season({
        seasonNumber: 2,
        status: MediaStatus.UNKNOWN,
        media: Promise.resolve(media),
      } as never)
    );
    await addEpisodes(3, MediaStatus.AVAILABLE);

    await notificationReconciler.run();

    assert.equal(
      caughtUp().length,
      1,
      'an unrequested season must not hold the notification back'
    );
  });

  it('says nothing while an early episode is missing, whatever came later', async () => {
    // Episode 1 missing; 2 and 3 here, and 4 and 5 (aired since) too.
    await getRepository(Episode).save(
      [2, 3, 4, 5].map(
        (episodeNumber) =>
          new Episode({
            episodeNumber,
            status: MediaStatus.AVAILABLE,
            season: Promise.resolve(season),
          } as never)
      )
    );

    await notificationReconciler.run();

    assert.deepEqual(
      caughtUp(),
      [],
      'four episodes are here, but not the first'
    );
  });

  it('never says a 4K request has caught up from the regular copy', async () => {
    const request = await getRepository(MediaRequest).findOneOrFail({
      where: { media: { id: media.id } },
    });
    await getRepository(MediaRequest).update(request.id, { is4k: true });
    await addEpisodes(3, MediaStatus.AVAILABLE);

    await notificationReconciler.run();

    assert.deepEqual(caughtUp(), []);
  });

  it('tries again on the next pass when sending fails', async () => {
    let fail = true;
    Object.defineProperty(MediaRequest, 'sendNotification', {
      configurable: true,
      value: async (_request: MediaRequest, _media: Media, type: number) => {
        if (fail) {
          return false;
        }
        sent.push(type);
        return true;
      },
    });
    await addEpisodes(3, MediaStatus.AVAILABLE);

    await notificationReconciler.run();
    assert.deepEqual(caughtUp(), [], 'the first send failed');

    fail = false;
    await notificationReconciler.run();
    assert.equal(caughtUp().length, 1, 'and the next pass sent it');
  });
});
