import migrateReleaseWait from '@server/lib/settings/migrations/0018_release_wait';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (settings: any) => migrateReleaseWait(settings) as any;

describe('the new release wait migration', () => {
  it('carries a wait saved under the old name over', () => {
    const after = run({ backfill: { newEpisodeWaitHours: 6 } });
    assert.deepEqual(after.backfill, { newReleaseWaitHours: 6 });
  });

  it('keeps a wait already saved under the new name', () => {
    const after = run({
      backfill: { newEpisodeWaitHours: 6, newReleaseWaitHours: 2 },
    });
    assert.deepEqual(after.backfill, { newReleaseWaitHours: 2 });
  });

  it('leaves settings without the old name alone', () => {
    assert.deepEqual(run({ backfill: { stuckAfterHours: 24 } }), {
      backfill: { stuckAfterHours: 24 },
    });
    assert.equal(run({}).backfill, undefined);
  });
});
