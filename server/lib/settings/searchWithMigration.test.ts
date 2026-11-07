import migrateBackfillSearchWith from '@server/lib/settings/migrations/0019_backfill_search_with';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Migration 0019: installs from before Backfill could search the *arrs keep
// searching as they did.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (settings: any) => migrateBackfillSearchWith(settings) as any;

const PROWLARR = {
  hostname: 'prowlarr',
  port: 9696,
  useSsl: false,
  urlBase: '',
  apiKey: 'k',
};

describe('the Backfill search source migration', () => {
  it('keeps an install with Prowlarr set up searching Prowlarr', () => {
    const after = run({ backfill: { enabled: true, prowlarr: PROWLARR } });
    assert.equal(after.backfill.searchWith, 'prowlarr');
  });

  it('has an install without Prowlarr search the *arrs', () => {
    assert.equal(
      run({ backfill: { prowlarr: { ...PROWLARR, hostname: '' } } }).backfill
        .searchWith,
      'arrs'
    );
    assert.equal(
      run({ backfill: { prowlarr: { ...PROWLARR, apiKey: '' } } }).backfill
        .searchWith,
      'arrs'
    );
    assert.equal(
      run({ backfill: { enabled: false } }).backfill.searchWith,
      'arrs'
    );
  });

  it('never overrides a choice already made', () => {
    for (const searchWith of ['prowlarr', 'arrs', 'both']) {
      const after = run({
        backfill: {
          searchWith,
          prowlarr: searchWith === 'arrs' ? PROWLARR : { hostname: '' },
        },
      });
      assert.equal(after.backfill.searchWith, searchWith);
    }
  });

  it('leaves a server without Backfill settings to the defaults', () => {
    assert.equal(run({}).backfill, undefined);
  });
});
