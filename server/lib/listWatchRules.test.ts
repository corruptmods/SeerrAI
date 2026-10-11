import type { TautulliHistoryRecord } from '@server/api/tautulli';
import {
  everyoneHasWatched,
  hasWatchedMovie,
  hasWatchedSeries,
  isCompletedPlay,
} from '@server/lib/listWatchRules';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const ADDED_AT = new Date('2026-06-01T00:00:00Z');
const seconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

const play = (
  overrides: Partial<TautulliHistoryRecord> = {}
): TautulliHistoryRecord =>
  ({
    watched_status: 1,
    percent_complete: 100,
    media_type: 'movie',
    date: seconds('2026-07-01T00:00:00Z'),
    parent_media_index: 1,
    media_index: 1,
    ...overrides,
  }) as TautulliHistoryRecord;

const episode = (season: number, number: number, iso: string) =>
  play({
    media_type: 'episode',
    parent_media_index: season,
    media_index: number,
    date: seconds(iso),
  });

describe('listWatchRules', () => {
  describe('isCompletedPlay', () => {
    it('accepts a play Tautulli marked watched', () => {
      assert.equal(
        isCompletedPlay(play({ watched_status: 1, percent_complete: 0 })),
        true
      );
    });

    it('falls back to completion percentage', () => {
      assert.equal(
        isCompletedPlay(play({ watched_status: 0, percent_complete: 90 })),
        true
      );
      assert.equal(
        isCompletedPlay(play({ watched_status: 0, percent_complete: 40 })),
        false
      );
    });
  });

  describe('hasWatchedMovie', () => {
    it('counts a completed play after the title was added', () => {
      assert.equal(hasWatchedMovie([play()], ADDED_AT), true);
    });

    it('ignores a viewing from before it was added', () => {
      // Adding something you watched years ago means you intend to watch it
      // again, so it should only clear once you actually do.
      const old = play({ date: seconds('2025-01-01T00:00:00Z') });

      assert.equal(hasWatchedMovie([old], ADDED_AT), false);
    });

    it('ignores an unfinished play', () => {
      const abandoned = play({ watched_status: 0, percent_complete: 12 });

      assert.equal(hasWatchedMovie([abandoned], ADDED_AT), false);
    });

    it('ignores episodes when judging a movie', () => {
      assert.equal(
        hasWatchedMovie([episode(1, 1, '2026-07-01T00:00:00Z')], ADDED_AT),
        false
      );
    });

    it('is false with no history at all', () => {
      assert.equal(hasWatchedMovie([], ADDED_AT), false);
    });
  });

  describe('hasWatchedSeries', () => {
    const available = new Set(['1:1', '1:2']);

    it('is true once every available episode has been watched', () => {
      const plays = [
        episode(1, 1, '2026-07-01T00:00:00Z'),
        episode(1, 2, '2026-07-02T00:00:00Z'),
      ];

      assert.equal(hasWatchedSeries(plays, ADDED_AT, available), true);
    });

    it('is false while an available episode is unwatched', () => {
      const plays = [episode(1, 1, '2026-07-01T00:00:00Z')];

      assert.equal(hasWatchedSeries(plays, ADDED_AT, available), false);
    });

    it('does not require episodes that are not in the library', () => {
      // Season two exists on TMDB but is not available; watching what is here
      // is enough.
      const plays = [
        episode(1, 1, '2026-07-01T00:00:00Z'),
        episode(1, 2, '2026-07-02T00:00:00Z'),
      ];

      assert.equal(hasWatchedSeries(plays, ADDED_AT, available), true);
    });

    it('ignores viewings from before the title was added', () => {
      const plays = [
        episode(1, 1, '2025-01-01T00:00:00Z'),
        episode(1, 2, '2025-01-02T00:00:00Z'),
      ];

      assert.equal(hasWatchedSeries(plays, ADDED_AT, available), false);
    });

    it('is false when nothing is available yet', () => {
      const plays = [episode(1, 1, '2026-07-01T00:00:00Z')];

      assert.equal(hasWatchedSeries(plays, ADDED_AT, new Set()), false);
    });

    it('treats the same episode number in different seasons separately', () => {
      const bothSeasons = new Set(['1:1', '2:1']);
      const onlySeasonOne = [episode(1, 1, '2026-07-01T00:00:00Z')];

      assert.equal(
        hasWatchedSeries(onlySeasonOne, ADDED_AT, bothSeasons),
        false
      );

      assert.equal(
        hasWatchedSeries(
          [...onlySeasonOne, episode(2, 1, '2026-07-03T00:00:00Z')],
          ADDED_AT,
          bothSeasons
        ),
        true
      );
    });
  });

  describe('everyoneHasWatched', () => {
    it('requires every member, not just one', () => {
      assert.equal(everyoneHasWatched([true, true]), true);
      assert.equal(everyoneHasWatched([true, false]), false);
    });

    it('is false when there is nobody to have watched it', () => {
      // An empty list must not read as "everyone is finished".
      assert.equal(everyoneHasWatched([]), false);
    });
  });
});
