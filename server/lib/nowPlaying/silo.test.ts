import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import SiloEpisode from '@server/entity/SiloEpisode';
import { User } from '@server/entity/User';
import nowPlaying from '@server/lib/nowPlaying';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { resetSiloHistorySync } from '@server/lib/siloHistory';
import { setupTestDb } from '@server/test/db';
import {
  createFakeSilo,
  siloEpisode,
  siloMovie,
  siloSeries,
} from '@server/test/fakeSilo';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * What someone is watching on Silo, from its live sessions, else what they
 * stopped in the last half hour, against a stand-in Silo.
 */

setupTestDb();

const silo = createFakeSilo();

before(() => silo.start());
after(() => silo.stop());

let viewer: User;

beforeEach(async () => {
  silo.reset();
  resetSiloHistorySync();
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.SILO;
  settings.plex.connected = false;
  settings.jellyfin.connected = false;
  settings.emby.connected = false;
  settings.silo = silo.settings();
  silo.items = [
    siloMovie('movie-glasswing', { title: 'Glasswing' }),
    siloSeries('series-harbour', { title: 'Harbour Lights' }),
    siloEpisode('series-harbour', 2, 4),
    siloEpisode('series-garden', 1, 1),
  ];
  viewer = await getRepository(User).save(
    new User({
      email: 'viewer@test.local',
      siloUserId: '2',
      siloProfileId: '21',
      permissions: Permission.REQUEST,
      avatar: '',
    })
  );
  await getRepository(Media).save([
    new Media({
      tmdbId: 9301,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.AVAILABLE,
      siloMediaId: 'movie-glasswing',
    }),
    new Media({
      tmdbId: 9302,
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
      siloMediaId: 'series-harbour',
    }),
    new Media({
      tmdbId: 9303,
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
      siloMediaId: 'series-garden',
    }),
  ]);
});

describe('what someone is watching on Silo', () => {
  it('reads their profile’s sessions, episodes by their series', async () => {
    await getRepository(SiloEpisode).save(
      new SiloEpisode({
        contentId: 'series-garden-1-1',
        seriesId: 'series-garden',
        libraryIds: ['2'],
        season: 1,
        episode: 1,
      })
    );
    silo.playing = [
      {
        session_id: 'a',
        user_id: '2',
        profile_id: '21',
        media_item_id: 'series-harbour-2-4',
        paused: true,
      },
      {
        session_id: 'b',
        user_id: '2',
        profile_id: '21',
        media_item_id: 'series-garden-1-1',
      },
      // Another profile on the same account, and someone else.
      {
        session_id: 'c',
        user_id: '2',
        profile_id: '20',
        media_item_id: 'movie-glasswing',
      },
      {
        session_id: 'd',
        user_id: '3',
        profile_id: '30',
        media_item_id: 'movie-glasswing',
      },
    ];
    const found = await nowPlaying.playingFor(viewer);
    assert.deepEqual(
      found.map((f) => [f.media.tmdbId, f.season, f.episode, f.paused]),
      [
        [9303, 1, 1, false],
        [9302, 2, 4, true],
      ]
    );
    assert.equal(found[1].title, 'Harbour Lights');
    assert.equal(found[1].server, 'silo');
    const asked = silo.calls.find((c) => c.path === '/admin/sessions');
    assert.equal(asked?.query.user_id, '2');
    // Only the episode the scans didn't list was looked up.
    const looked = silo.calls.find((c) => c.path === '/admin/catalog/items');
    assert.deepEqual(looked?.queryAll.content_ids, ['series-harbour-2-4']);
  });

  it('counts every profile for someone who chose none', async () => {
    viewer.siloProfileId = null;
    await getRepository(User).save(viewer);
    silo.playing = [
      {
        session_id: 'c',
        user_id: '2',
        profile_id: '20',
        media_item_id: 'movie-glasswing',
      },
    ];
    const found = await nowPlaying.playingFor(viewer);
    assert.deepEqual(
      found.map((f) => f.media.tmdbId),
      [9301]
    );
  });

  it('falls back to what they stopped in the last half hour', async () => {
    silo.plays = [
      {
        session_id: 'p-1',
        user_id: '2',
        profile_id: '21',
        media_item_id: 'movie-glasswing',
        ended_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        end_position_seconds: 1200,
        duration_seconds: 6000,
        completed: false,
      },
    ];
    const found = await nowPlaying.playingFor(viewer);
    assert.deepEqual(
      found.map((f) => [f.media.tmdbId, f.seen]),
      [[9301, 'recent']]
    );
  });

  it('says nothing, without failing, while Silo is down', async () => {
    silo.down = true;
    assert.deepEqual(await nowPlaying.playingFor(viewer), []);
  });
});
