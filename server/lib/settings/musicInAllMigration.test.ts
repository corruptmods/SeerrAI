import type { AllSettings } from '@server/lib/settings';
import migrateMusicInAllSearch from '@server/lib/settings/migrations/0015_music_in_all_search';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Settings migration 0015: music in All search results started off, and
 * that was saved. A saved "off" goes back to the new default (on once
 * Lidarr is set up), once; "on" is kept.
 */

const run = (settings: unknown) =>
  migrateMusicInAllSearch(
    structuredClone(settings) as unknown as AllSettings
  ) as unknown as { music?: { search?: object }; migrations: string[] };

describe('settings migration 0015', () => {
  it('clears a saved off, and keeps a saved on', () => {
    assert.deepEqual(run({ music: { search: { inAll: false } } }).music, {
      search: {},
    });
    assert.deepEqual(run({ music: { search: { inAll: true } } }).music, {
      search: { inAll: true },
    });
    assert.deepEqual(run({}).migrations, ['0015_music_in_all_search']);
  });

  it('runs once, so turning it off later sticks', () => {
    const settings = {
      music: { search: { inAll: false } },
      migrations: ['0015_music_in_all_search'],
    };
    assert.deepEqual(run(settings), settings);
  });
});
