import type { PlanEntry } from '@server/lib/backfill/plan';
import {
  limitsOf,
  sizeNote,
  sizeProblems,
} from '@server/lib/backfill/sizeLimits';
import type { SonarrQualityProfile } from '@server/lib/backfill/sonarr';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * Sonarr's and Radarr's size limits in MB per minute: the profile's (Sonarr
 * v5) before the app's, and multi-episode files allowed that many times
 * one's.
 */

const MB = 1024 * 1024;
const WEB = { id: 3, name: 'WEBDL-1080p' };
const BLURAY = { id: 7, name: 'Bluray-1080p' };

const profile: SonarrQualityProfile = {
  id: 1,
  name: 'HD',
  upgradeAllowed: true,
  cutoff: 7,
  items: [
    {
      name: 'WEB 1080p',
      allowed: true,
      items: [{ quality: WEB, allowed: true, minSize: 4, maxSize: 60 }],
    },
    { quality: BLURAY, allowed: true },
  ],
  minFormatScore: 0,
  cutoffFormatScore: 0,
};

const entry = (
  quality: { id: number; name: string },
  sizeMb: number,
  episodes = 1,
  action: PlanEntry['action'] = 'fill'
): PlanEntry => ({
  index: 0,
  path: 'x.mkv',
  size: sizeMb * MB,
  judgedAs: 'x',
  episodeIds: Array.from({ length: episodes }, (_, i) => i + 1),
  quality: { quality, revision: { version: 1, real: 0 } },
  score: 0,
  action,
  replaces: 0,
});

describe('size limits', () => {
  const limits = limitsOf(profile, [
    { quality: WEB, minSize: 1, maxSize: 1000 },
    { quality: BLURAY, minSize: 5, maxSize: 100 },
  ]);

  it('takes the profile’s own limits before the app’s', () => {
    assert.deepEqual(limits.get(WEB.id), { min: 4, max: 60 });
    assert.deepEqual(limits.get(BLURAY.id), { min: 5, max: 100 });
  });

  it('finds files over or under, by the minute, a pack of several episodes times as many', () => {
    // 40-minute episodes: WEB 1080p may be 160 MB to 2400 MB.
    assert.deepEqual(
      sizeProblems([entry(WEB, 2000)], limits, 40, 'Sonarr'),
      []
    );
    const over = sizeProblems([entry(WEB, 3000)], limits, 40, 'Sonarr');
    assert.equal(over.length, 1);
    assert.equal(
      sizeNote(over),
      "Outside the size limits: 2.9 GB is over Sonarr's WEBDL-1080p limit of 2.3 GB"
    );
    assert.deepEqual(
      sizeProblems([entry(WEB, 3000, 2)], limits, 40, 'Sonarr'),
      []
    );
    assert.match(
      sizeProblems([entry(WEB, 100)], limits, 40, 'Sonarr')[0].note,
      /under Sonarr's WEBDL-1080p minimum/
    );
  });

  it('passes what it cannot judge, and files not taken', () => {
    assert.deepEqual(sizeProblems([entry(WEB, 9000)], limits, 0, 'Sonarr'), []);
    assert.deepEqual(
      sizeProblems(
        [entry({ id: 99, name: 'Other' }, 9000)],
        limits,
        40,
        'Sonarr'
      ),
      []
    );
    assert.deepEqual(
      sizeProblems([entry(WEB, 9000, 1, 'skip')], limits, 40, 'Sonarr'),
      []
    );
  });
});
