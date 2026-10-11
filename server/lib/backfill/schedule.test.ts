import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import BackfillSeries from '@server/entity/BackfillSeries';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { pickSearches, requestedSince } from '@server/lib/backfill/engine';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

/*
 * Which titles a scan searches: what someone asked for first, but every
 * title in turn, so the same few never take every scan.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 7, 12);
const settings = { searchesPerScan: 2, researchAfterDays: 7 };

let nextId = 1;
const row = (over: Partial<BackfillSeries> = {}) =>
  Object.assign(
    new BackfillSeries({
      kind: 'series',
      serverId: 0,
      arrId: nextId,
      title: `Title ${nextId}`,
      status: 'stuck',
      missing: 1,
    }),
    { id: nextId++, lastSearchedAt: null },
    over
  );
const ids = (rows: BackfillSeries[]) => rows.map((r) => r.id);
const ago = (ms: number) => new Date(NOW - ms);

describe('choosing what a scan searches', () => {
  it('searches what was asked for first, oldest request first, then the most missing', () => {
    const plain = row({ missing: 40 });
    const askedLately = row({ missing: 1 });
    const askedLongAgo = row({ missing: 2 });
    const requested = new Map([
      [askedLately.id, ago(1 * DAY)],
      [askedLongAgo.id, ago(30 * DAY)],
    ]);
    assert.deepEqual(
      ids(
        pickSearches(
          [plain, askedLately, askedLongAgo],
          requested,
          { ...settings, searchesPerScan: 3 },
          NOW
        )
      ),
      [askedLongAgo.id, askedLately.id, plain.id]
    );
  });

  it('never gives every scan to the same titles, asked for or not', () => {
    // Five asked-for titles and three others, two searches a scan, nothing
    // ever found: each scan's titles wait their turn after it.
    const asked = Array.from({ length: 5 }, () => row());
    const others = Array.from({ length: 3 }, () => row());
    const all = [...asked, ...others];
    const requested = new Map(asked.map((r, i) => [r.id, ago((10 - i) * DAY)]));
    const searched: number[] = [];
    for (let scan = 0; scan < 4; scan++) {
      const now = NOW + scan * 6 * HOUR;
      for (const r of pickSearches(all, requested, settings, now)) {
        searched.push(r.id);
        r.status = 'none';
        r.lastSearchedAt = new Date(now);
      }
    }
    assert.deepEqual(searched, ids(all), 'each searched once, asked-for first');
  });

  it('tries a failed search again a day later, not every scan', () => {
    const failed = row({ status: 'stuck', lastSearchedAt: ago(2 * HOUR) });
    const fresh = row();
    const requested = new Map([[failed.id, ago(9 * DAY)]]);
    assert.deepEqual(
      ids(pickSearches([failed, fresh], requested, settings, NOW)),
      [fresh.id]
    );
    assert.deepEqual(
      ids(pickSearches([failed], requested, settings, NOW + DAY)),
      [failed.id]
    );
  });

  it('searches a title that found nothing again after the set days', () => {
    const none = row({ status: 'none', lastSearchedAt: ago(6 * DAY) });
    assert.deepEqual(pickSearches([none], new Map(), settings, NOW), []);
    assert.deepEqual(
      ids(pickSearches([none], new Map(), settings, NOW + 2 * DAY)),
      [none.id]
    );
  });

  it('puts titles never searched ahead of ones waiting to be searched again', () => {
    const again = row({ status: 'none', lastSearchedAt: ago(30 * DAY) });
    const never = row();
    const requested = new Map([[again.id, ago(60 * DAY)]]);
    assert.deepEqual(
      ids(
        pickSearches(
          [again, never],
          requested,
          {
            ...settings,
            searchesPerScan: 1,
          },
          NOW
        )
      ),
      [never.id]
    );
  });
});

describe('which titles someone asked for', () => {
  it('reads open requests only, and keeps films and series apart', async () => {
    const user = await getRepository(User).findOneOrFail({ where: { id: 1 } });
    const media = async (tmdbId: number, mediaType: MediaType) =>
      getRepository(Media).save(
        new Media({
          tmdbId,
          mediaType,
          status: MediaStatus.PROCESSING,
          status4k: MediaStatus.UNKNOWN,
        })
      );
    const request = async (
      m: Media,
      status: MediaRequestStatus,
      createdAt: Date
    ) => {
      // Saved as it is: nothing is sent to Sonarr or Radarr.
      const saved = await getRepository(MediaRequest).save(
        new MediaRequest({
          media: m,
          type: m.mediaType,
          status,
          requestedBy: user,
          is4k: false,
        }),
        { listeners: false }
      );
      await getRepository(MediaRequest).update(saved.id, { createdAt });
    };
    const show = await media(100, MediaType.TV);
    const film = await media(100, MediaType.MOVIE);
    const done = await media(200, MediaType.TV);
    await request(show, MediaRequestStatus.APPROVED, ago(3 * DAY));
    await request(show, MediaRequestStatus.APPROVED, ago(9 * DAY));
    await request(done, MediaRequestStatus.COMPLETED, ago(9 * DAY));
    await request(film, MediaRequestStatus.DECLINED, ago(9 * DAY));

    const series = row({ tmdbId: 100 });
    const movie = row({ kind: 'movie', tmdbId: 100 });
    const finished = row({ tmdbId: 200 });
    const since = await requestedSince([series, movie, finished]);
    assert.deepEqual([...since.keys()], [series.id]);
    assert.ok(
      Math.abs(since.get(series.id)!.getTime() - ago(9 * DAY).getTime()) < 2000,
      'the oldest open request'
    );
  });
});
