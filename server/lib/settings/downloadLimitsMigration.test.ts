import migrateSplitDownloadLimits from '@server/lib/settings/migrations/0016_split_download_limits';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Backfill's one limit on downloads at once becomes series, movies and
 * music, each starting at what it was.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (settings: any) => migrateSplitDownloadLimits(settings) as any;

describe('the split download limits migration', () => {
  it('starts movies and music at the old limit, once', () => {
    const after = run({ backfill: { maxActiveJobs: 4 } });
    assert.equal(after.backfill.maxActiveJobs, 4);
    assert.equal(after.backfill.maxMovieJobs, 4);
    assert.equal(after.backfill.maxMusicJobs, 4);
    assert.deepEqual(after.migrations, ['0016_split_download_limits']);

    // Changed since: left as chosen.
    after.backfill.maxMovieJobs = 1;
    assert.equal(run(after).backfill.maxMovieJobs, 1);
  });

  it('leaves a server without Backfill settings to the defaults', () => {
    assert.equal(run({}).backfill, undefined);
  });
});
