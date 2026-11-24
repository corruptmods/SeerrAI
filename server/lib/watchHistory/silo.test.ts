import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Episode from '@server/entity/Episode';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import { recentWatching } from '@server/lib/ai/context';
import { recapPosition } from '@server/lib/ai/features';
import { Permission } from '@server/lib/permissions';
import { getSeriesProgress } from '@server/lib/seriesProgress';
import { getSettings } from '@server/lib/settings';
import { resetSiloHistorySync } from '@server/lib/siloHistory';
import { forgetWatched, watchedFor } from '@server/lib/watched';
import { getWatchedBy } from '@server/lib/watchedBy';
import { watchSource } from '@server/lib/watchHistory';
import { CompositeWatchSource } from '@server/lib/watchHistory/composite';
import { SiloWatchSource } from '@server/lib/watchHistory/silo';
import { setupTestDb } from '@server/test/db';
import type { FakeSiloPlay } from '@server/test/fakeSilo';
import {
  createFakeSilo,
  siloEpisode,
  siloMovie,
  siloSeries,
} from '@server/test/fakeSilo';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Silo's watch history as WatchSource answers it, from Seerr AI's copy, and
 * the features that read it: Who Watched, Hide What You've Watched, Catch Me
 * Up and the AI's sense of what someone watched. Suggested for You and Pick
 * for the Room are covered with Silo in routes/ai.test.ts.
 */

setupTestDb();

const silo = createFakeSilo();

before(() => silo.start());
after(() => silo.stop());

const HOUR = 60 * 60 * 1000;
const ago = (hours: number) =>
  new Date(Date.now() - hours * HOUR).toISOString();

let n = 0;
const play = (
  userId: string,
  profileId: string,
  itemId: string,
  hoursAgo: number,
  completed = true
): FakeSiloPlay => ({
  session_id: `s-${++n}`,
  user_id: userId,
  profile_id: profileId,
  media_item_id: itemId,
  ended_at: ago(hoursAgo),
  end_position_seconds: completed ? 5800 : 600,
  duration_seconds: 6000,
  completed,
});

let lantern: User;
let garden: User;
let glasswing: Media;
let harbour: Media;

beforeEach(async () => {
  silo.reset();
  resetSiloHistorySync();
  forgetWatched();
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.SILO;
  settings.plex.connected = false;
  settings.jellyfin.connected = false;
  settings.emby.connected = false;
  settings.tautulli = { ...settings.tautulli, hostname: '', apiKey: '' };
  settings.silo = silo.settings();
  silo.accounts = [
    {
      id: '2',
      username: 'lantern',
      password: 'song',
      role: 'user',
      profiles: [
        { id: '20', name: 'Lantern', is_primary: true },
        { id: '21', name: 'Garden', is_primary: false, is_child: true },
      ],
    },
    { id: '3', username: 'harbour', password: 'lights', role: 'user' },
  ];
  silo.items = [
    siloMovie('movie-glasswing', { title: 'Glasswing' }),
    siloSeries('series-harbour', { title: 'Harbour Lights' }),
    siloEpisode('series-harbour', 1, 1),
    siloEpisode('series-harbour', 1, 2),
    siloEpisode('series-harbour', 1, 3),
  ];
  // A fresh pair of ids each test, so no cached answer carries over.
  const tag = `${++n}`;
  silo.items = silo.items.map((item) =>
    item.series_id
      ? {
          ...item,
          series_id: `${item.series_id}-${tag}`,
          content_id: `${item.series_id}-${tag}-${item.season_number}-${item.episode_number}`,
        }
      : { ...item, content_id: `${item.content_id}-${tag}` }
  );
  // Lantern counts the whole account; Garden, its child profile, only theirs.
  lantern = await getRepository(User).save(
    new User({
      email: `lantern-${tag}@test.local`,
      siloUserId: '2',
      siloUsername: 'lantern',
      permissions: Permission.REQUEST,
      avatar: '',
    })
  );
  garden = await getRepository(User).save(
    new User({
      email: `garden-${tag}@test.local`,
      siloUserId: '2',
      siloUsername: 'lantern',
      siloProfileId: '21',
      permissions: Permission.REQUEST,
      avatar: '',
    })
  );
  glasswing = await getRepository(Media).save(
    new Media({
      tmdbId: 8101,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.AVAILABLE,
      siloMediaId: `movie-glasswing-${tag}`,
    })
  );
  harbour = await getRepository(Media).save(
    new Media({
      tmdbId: 8102,
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
      siloMediaId: `series-harbour-${tag}`,
    })
  );
  const season = await getRepository(Season).save(
    new Season({
      seasonNumber: 1,
      status: MediaStatus.AVAILABLE,
      media: Promise.resolve(harbour),
    } as never)
  );
  for (let episode = 1; episode <= 3; episode++) {
    await getRepository(Episode).save(
      new Episode({
        episodeNumber: episode,
        status: MediaStatus.AVAILABLE,
        season: Promise.resolve(season),
      } as never)
    );
  }
});

const ids = () => ({
  movie: glasswing.siloMediaId as string,
  episode: (e: number) => `${harbour.siloMediaId}-1-${e}`,
});

describe('Silo watch history', () => {
  it('is the source while Silo is connected with a key', () => {
    assert.ok(watchSource() instanceof SiloWatchSource);
    getSettings().plex.connected = true;
    getSettings().tautulli = {
      ...getSettings().tautulli,
      hostname: 'tautulli.invalid',
      apiKey: 'k',
    };
    assert.ok(watchSource() instanceof CompositeWatchSource);
  });

  it('answers a person’s plays newest first, by their account or chosen profile', async () => {
    silo.plays = [
      play('2', '20', ids().movie, 5),
      play('2', '21', ids().episode(1), 3, false),
      play('3', '30', ids().episode(2), 1),
    ];
    const source = new SiloWatchSource();
    const all = await source.history(lantern, 10);
    assert.deepEqual(
      all.map((p) => [p.titleId, p.kind, p.finished, p.viewerId]),
      [
        [harbour.siloMediaId, 'episode', false, '2/21'],
        [glasswing.siloMediaId, 'movie', true, '2/20'],
      ]
    );
    assert.equal(all[0].percent, 10);
    assert.equal(all[0].season, 1);
    assert.equal(all[0].episode, 1);
    assert.equal(all[0].title, 'Harbour Lights');
    assert.equal(all[0].viewerName, 'Garden');
    const child = await source.history(garden, 10);
    assert.deepEqual(
      child.map((p) => p.itemId),
      [ids().episode(1)]
    );
    assert.equal(source.viewerOf(garden), '2/21');
    assert.equal(source.viewerOf(lantern), '2');
  });

  it('reads only plays since a time, for one title', async () => {
    silo.plays = [
      play('2', '20', ids().episode(1), 30),
      play('2', '20', ids().episode(2), 2),
      play('2', '20', ids().movie, 1),
    ];
    const since = await new SiloWatchSource().playsSince(
      lantern,
      harbour,
      new Date(Date.now() - 10 * HOUR)
    );
    assert.deepEqual(
      since.map((p) => p.itemId),
      [ids().episode(2)]
    );
  });

  it('fails loudly when Silo can’t be read, rather than saying nothing was watched', async () => {
    silo.plays = [play('2', '20', ids().movie, 1)];
    silo.down = true;
    const source = new SiloWatchSource();
    await assert.rejects(() => source.history(lantern, 10));
    await assert.rejects(() =>
      source.playsSince(lantern, glasswing, new Date(0))
    );
    await assert.rejects(() => source.titleHistory(glasswing));
  });

  it('gives each profile’s plays to whoever chose it, the rest to the whole account', async () => {
    const source = new SiloWatchSource();
    const users = await source.usersFor(['2/21', '2/20', '2', '3/30']);
    assert.equal(users.get('2/21')?.id, garden.id);
    assert.equal(users.get('2/20')?.id, lantern.id);
    assert.equal(users.get('2')?.id, lantern.id);
    assert.equal(users.get('3/30'), undefined);
  });
});

describe('features reading Silo’s history', () => {
  it('Who Watched names each person, and Silo’s own name for anyone else', async () => {
    silo.plays = [
      play('2', '21', ids().movie, 4),
      play('2', '20', ids().movie, 2),
      play('3', '30', ids().movie, 1),
      play('3', '30', ids().movie, 6, false),
    ];
    const watched = await getWatchedBy(glasswing);
    assert.deepEqual(
      watched?.map((w) => [w.user?.id ?? w.name, w.count]),
      [
        ['harbour', 1],
        [lantern.id, 1],
        [garden.id, 1],
      ]
    );
  });

  it('Hide What You’ve Watched knows what someone finished or started', async () => {
    silo.plays = [
      play('2', '20', ids().movie, 4),
      play('2', '21', ids().episode(1), 2, false),
    ];
    assert.deepEqual([...(await watchedFor(lantern)).keys].sort(), [
      'movie:8101',
    ]);
    forgetWatched();
    silo.plays.push(play('2', '21', ids().episode(1), 1));
    // Past the half minute a fresh copy is trusted for.
    resetSiloHistorySync();
    assert.deepEqual([...(await watchedFor(garden)).keys].sort(), ['tv:8102']);
  });

  it('Catch Me Up recaps up to just after the furthest episode finished', async () => {
    silo.plays = [
      play('2', '20', ids().episode(1), 5),
      play('2', '20', ids().episode(2), 4),
      play('2', '20', ids().episode(3), 3, false),
    ];
    const progress = (await getSeriesProgress(lantern, [8102]))[8102];
    assert.deepEqual(progress?.furthest, { season: 1, episode: 2 });
    assert.deepEqual(progress?.next, { season: 1, episode: 3 });
    assert.deepEqual(await recapPosition(lantern, 8102), {
      season: 1,
      episode: 3,
    });
  });

  it('the AI knows what someone watched recently', async () => {
    silo.plays = [
      play('2', '20', ids().movie, 3),
      play('2', '20', ids().episode(1), 1),
    ];
    const names = await recentWatching(lantern, 10, { serverOnly: true });
    assert.equal(names.length, 2);
    assert.match(names[0], /Harbour Lights/);
    assert.match(names[1], /Glasswing/);
  });
});
