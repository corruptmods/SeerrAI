import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import SiloEpisode from '@server/entity/SiloEpisode';
import SiloPlay from '@server/entity/SiloPlay';
import { runDbMaintenance } from '@server/lib/dbMaintenance';
import { getSettings } from '@server/lib/settings';
import {
  SILO_HISTORY_OVERLAP_MS,
  resetSiloHistorySync,
  siloHistorySync,
  syncSiloHistory,
} from '@server/lib/siloHistory';
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
 * Seerr AI's copy of Silo's play history: the first read, the watermark and
 * its overlap, titles found when a play is copied and kept after the item
 * leaves Silo, the nightly full re-read, and Silo being down.
 */

setupTestDb();

const silo = createFakeSilo();

before(() => silo.start());
after(() => silo.stop());

const MINUTE = 60 * 1000;
const base = Date.parse('2026-11-20T20:00:00.000Z');
const at = (minutes: number) => new Date(base + minutes * MINUTE).toISOString();

const play = (
  sessionId: string,
  itemId: string,
  minutes: number,
  fields: Partial<FakeSiloPlay> = {}
): FakeSiloPlay => ({
  session_id: sessionId,
  user_id: '2',
  profile_id: '20',
  media_item_id: itemId,
  ended_at: at(minutes),
  end_position_seconds: 3000,
  duration_seconds: 6000,
  completed: false,
  ...fields,
});

const stored = async () =>
  new Map(
    (await getRepository(SiloPlay).find()).map((row) => [row.sessionId, row])
  );

const historyCalls = () =>
  silo.calls.filter((call) => call.path === '/admin/playback-history');

beforeEach(() => {
  silo.reset();
  resetSiloHistorySync();
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.SILO;
  settings.plex.connected = false;
  settings.jellyfin.connected = false;
  settings.emby.connected = false;
  settings.silo = silo.settings();
  silo.accounts = [
    {
      id: '2',
      username: 'lantern',
      password: 'song',
      role: 'user',
      profiles: [{ id: '20', name: 'Lantern', is_primary: true }],
    },
  ];
  silo.items = [
    siloMovie('movie-glasswing', { title: 'Glasswing' }),
    siloSeries('series-garden', { title: 'Static Garden' }),
    siloEpisode('series-garden', 1, 1),
    siloEpisode('series-garden', 1, 2),
    { ...siloMovie('book-1', { title: 'Lantern Song' }), type: 'audiobook' },
  ];
});

describe('copying Silo’s play history', () => {
  it('copies everything on the first read, every page of it', async () => {
    silo.plays = Array.from({ length: 205 }, (_, i) =>
      play(`s-${String(i).padStart(3, '0')}`, 'movie-glasswing', i)
    );
    const result = await syncSiloHistory();
    assert.equal(result.read, 205);
    assert.equal(await getRepository(SiloPlay).count(), 205);
    assert.equal(historyCalls().length, 2, 'two pages of 200');
    assert.equal(historyCalls()[0].query.ended_after, undefined);
  });

  it('places each play: films, episodes by their series, and nothing else', async () => {
    silo.plays = [
      play('s-movie', 'movie-glasswing', 1, {
        completed: true,
        end_position_seconds: 5900,
      }),
      play('s-episode', 'series-garden-1-2', 2),
      play('s-book', 'book-1', 3),
      play('s-none', '', 4),
    ];
    await syncSiloHistory();
    const rows = await stored();
    assert.deepEqual([...rows.keys()].sort(), ['s-episode', 's-movie']);
    const movie = rows.get('s-movie');
    assert.equal(movie?.kind, 'movie');
    assert.equal(movie?.titleId, 'movie-glasswing');
    assert.equal(movie?.title, 'Glasswing');
    assert.equal(movie?.completed, true);
    assert.equal(movie?.percent, 98);
    assert.equal(movie?.viewerName, 'Lantern');
    assert.equal(movie?.profileId, '20');
    const episode = rows.get('s-episode');
    assert.equal(episode?.kind, 'episode');
    assert.equal(episode?.titleId, 'series-garden', 'its series, found now');
    assert.equal(episode?.title, 'Static Garden');
    assert.equal(episode?.season, 1);
    assert.equal(episode?.episode, 2);
    assert.equal(episode?.percent, 50);
    // The episode's series came from Silo's catalog, asked one id each.
    const asked = silo.calls.find((c) => c.path === '/admin/catalog/items');
    assert.deepEqual(asked?.queryAll.content_ids, ['series-garden-1-2']);
  });

  it('places an episode Silo no longer has from the scans’ list, and keeps one nothing knows', async () => {
    await getRepository(SiloEpisode).save(
      new SiloEpisode({
        contentId: 'series-harbour-2-3',
        seriesId: 'series-harbour',
        libraryIds: ['2'],
        season: 2,
        episode: 3,
      })
    );
    silo.plays = [
      play('s-known', 'series-harbour-2-3', 1),
      play('s-unknown', 'gone-item', 2),
    ];
    await syncSiloHistory();
    const rows = await stored();
    assert.equal(rows.get('s-known')?.titleId, 'series-harbour');
    assert.equal(rows.get('s-known')?.season, 2);
    assert.equal(rows.get('s-known')?.episode, 3);
    // Kept with what is known, in case Silo ever says more.
    assert.equal(rows.get('s-unknown')?.titleId, null);
    assert.equal(rows.get('s-unknown')?.kind, '');
  });

  it('reads on from just before the newest play it holds, and keeps titles once items leave', async () => {
    silo.plays = [play('s-1', 'series-garden-1-1', 10)];
    await syncSiloHistory();
    // Silo moved s-1's end on (it ended again, finished), a new play came,
    // and the episode left Silo's catalog.
    silo.plays = [
      play('s-1', 'series-garden-1-1', 20, { completed: true }),
      play('s-2', 'movie-glasswing', 25),
    ];
    silo.items = silo.items.filter(
      (item) => item.content_id !== 'series-garden-1-1'
    );
    silo.calls = [];
    await syncSiloHistory();
    assert.equal(
      historyCalls()[0].query.ended_after,
      new Date(Date.parse(at(10)) - SILO_HISTORY_OVERLAP_MS).toISOString()
    );
    const rows = await stored();
    assert.equal(rows.size, 2, 'one row per session');
    assert.equal(rows.get('s-1')?.completed, true);
    assert.equal(rows.get('s-1')?.endedAt.toISOString(), at(20));
    assert.equal(rows.get('s-1')?.titleId, 'series-garden', 'kept');
    assert.equal(rows.get('s-1')?.title, 'Static Garden', 'kept');
    assert.equal(rows.get('s-1')?.episode, 1, 'kept');
    assert.ok(
      !silo.calls.some((c) => c.path === '/admin/catalog/items'),
      'a play already placed is not looked up again'
    );
  });

  it('picks up a play Silo recorded while it was being read', async () => {
    silo.plays = Array.from({ length: 201 }, (_, i) =>
      play(`s-${String(i).padStart(3, '0')}`, 'movie-glasswing', i)
    );
    silo.afterHistoryPage = () => {
      silo.afterHistoryPage = undefined;
      silo.plays.push(play('s-late', 'movie-glasswing', 300));
    };
    await syncSiloHistory();
    assert.equal((await stored()).has('s-late'), false, 'not this time');
    await syncSiloHistory();
    assert.equal((await stored()).has('s-late'), true, 'next time');
  });

  it('fails while Silo is down, keeping the copy, and the job waits for its next run', async () => {
    silo.plays = [play('s-1', 'movie-glasswing', 1)];
    await syncSiloHistory();
    silo.down = true;
    await assert.rejects(() => syncSiloHistory());
    await siloHistorySync.run();
    assert.equal(await getRepository(SiloPlay).count(), 1);
    silo.down = false;
    silo.apiMajor = 3;
    await assert.rejects(() => syncSiloHistory(), /API v3/);
  });

  it('reads once for callers that ask at the same time', async () => {
    silo.plays = [play('s-1', 'movie-glasswing', 1)];
    await Promise.all([syncSiloHistory(), syncSiloHistory()]);
    assert.equal(historyCalls().length, 1);
  });
});

describe('the nightly full re-read', () => {
  it('drops only plays Silo no longer has, whatever their age, and follows a moved play', async () => {
    silo.plays = [
      play('s-old', 'movie-glasswing', -60 * 24 * 365 * 3),
      play('s-gone', 'movie-glasswing', 5),
      play('s-moved', 'series-garden-1-1', 6),
    ];
    await syncSiloHistory();
    // Silo deleted s-gone, and moved s-moved to another episode.
    silo.plays = [
      play('s-old', 'movie-glasswing', -60 * 24 * 365 * 3),
      play('s-moved', 'series-garden-1-2', 6),
    ];
    const report = await runDbMaintenance();
    assert.equal(report?.removed.siloPlays, 1);
    assert.equal(report?.rows.siloPlays, 2);
    const rows = await stored();
    assert.deepEqual([...rows.keys()].sort(), ['s-moved', 's-old']);
    assert.equal(rows.get('s-moved')?.itemId, 'series-garden-1-2');
    assert.equal(rows.get('s-moved')?.episode, 2);
  });

  it('keeps a play Silo moved on while the long read ran', async () => {
    silo.plays = Array.from({ length: 201 }, (_, i) =>
      play(`s-${String(i).padStart(3, '0')}`, 'movie-glasswing', i)
    );
    await syncSiloHistory();
    // While the first page is read, the oldest play ends again: it jumps to
    // the front, behind the read.
    silo.afterHistoryPage = () => {
      silo.afterHistoryPage = undefined;
      const oldest = silo.plays.find((p) => p.session_id === 's-000');
      if (oldest) oldest.ended_at = at(400);
    };
    const result = await syncSiloHistory({ full: true });
    assert.equal(result.removed, 0);
    assert.equal((await stored()).get('s-000')?.endedAt.toISOString(), at(400));
  });

  it('keeps everything when Silo lists no plays at all, or can’t be read', async () => {
    silo.plays = [
      play('s-1', 'movie-glasswing', 1),
      play('s-2', 'movie-glasswing', 2),
    ];
    await syncSiloHistory();
    silo.plays = [];
    assert.equal((await runDbMaintenance())?.removed.siloPlays, 0);
    silo.down = true;
    assert.equal((await runDbMaintenance())?.removed.siloPlays, 0);
    assert.equal(await getRepository(SiloPlay).count(), 2);
  });

  it('forgets the copy once Silo is disconnected', async () => {
    silo.plays = [play('s-1', 'movie-glasswing', 1)];
    await syncSiloHistory();
    const settings = getSettings();
    settings.silo.connected = false;
    settings.main.mediaServerType = MediaServerType.PLEX;
    settings.plex.connected = true;
    assert.equal((await runDbMaintenance())?.removed.siloPlays, 1);
    assert.equal(await getRepository(SiloPlay).count(), 0);
  });
});
