import { getRepository } from '@server/datasource';
import SongFetch from '@server/entity/SongFetch';
import { WAITING_FOR_SLOT } from '@server/lib/music/songFetch';
import { songPace } from '@server/lib/music/songPace';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Settings → Music's pace: each limit songs are held to, and how much of
 * it is in use.
 */

setupTestDb();

const NOW = new Date('2026-11-04T12:00:00Z');
const HOUR_MS = 60 * 60_000;

const fetchWith = (fields: Partial<SongFetch>) =>
  getRepository(SongFetch).save(
    new SongFetch({
      albumMbid: '4f6a2d93-c1e8-3a57-9b02-6d3e8f1c7a40',
      albumTitle: 'Static Garden',
      artistMbid: 'b0a1c2d3-0000-4000-8000-000000000001',
      artistName: 'Glasswing',
      recordings: [],
      status: 'searching',
      lidarrId: 0,
      files: [],
      tried: [],
      ...fields,
    })
  );

describe('how fast songs move', () => {
  it('counts what is searching, waiting, downloading and importing', async () => {
    getSettings().backfill.maxMusicJobs = 2;
    await fetchWith({});
    await fetchWith({ searchAgainAt: new Date(NOW.getTime() + 3 * HOUR_MS) });
    await fetchWith({ searchAgainAt: new Date(NOW.getTime() + HOUR_MS) });
    await fetchWith({ stage: WAITING_FOR_SLOT });
    await fetchWith({ status: 'downloading' });
    await fetchWith({ status: 'importing' });
    await fetchWith({ status: 'done' });

    const pace = await songPace(NOW);
    assert.equal(pace.albums.searching, 1);
    assert.equal(pace.albums.waitingToSearchAgain, 2);
    assert.equal(
      pace.albums.nextSearchAt,
      new Date(NOW.getTime() + HOUR_MS).toISOString()
    );
    assert.deepEqual(pace.albums.searchAgainHours, [1, 3, 6, 12, 24]);
    assert.deepEqual(pace.downloads, {
      slots: 2,
      downloading: 1,
      waitingForSlot: 1,
      importing: 1,
    });
    assert.equal(pace.matching.perPass, 40);
    assert.equal(pace.singles.searchesPerMinute, 3);
  });
});
