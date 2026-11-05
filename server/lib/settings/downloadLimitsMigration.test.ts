import migrateSplitDownloadLimits from '@server/lib/settings/migrations/0016_split_download_limits';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Migration 0016: one download limit splits into series, movies and music at
// the old value.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (settings: any) => migrateSplitDownloadLimits(settings) as any;

describe('the split download limits migration', () => {
  it('starts movies and music at the old limit, once', () => {
    const after = run({ backfill: { maxActiveJobs: 4 } });
    assert.equal(after.backfill.maxActiveJobs, 4);
    assert.equal(after.backfill.maxMovieJobs, 4);
    assert.equal(after.backfill.maxMusicJobs, 4);
    assert.deepEqual(after.migrations, ['0016_split_download_limits']);

    // A later change is left alone.
    after.backfill.maxMovieJobs = 1;
    assert.equal(run(after).backfill.maxMovieJobs, 1);
  });

  it('leaves a server without Backfill settings to the defaults', () => {
    assert.equal(run({}).backfill, undefined);
  });
});
