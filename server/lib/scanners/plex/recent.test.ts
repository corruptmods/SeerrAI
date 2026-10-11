import type { PlexLibraryItem } from '@server/api/plexapi';
import PlexAPI from '@server/api/plexapi';
import { plexRecentScanner } from '@server/lib/scanners/plex';
import { RETRY_FOR_MS, RecentRetries } from '@server/lib/scanners/plex/recent';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

setupTestDb();

/*
 * The Plex recently added scan: a title Plex added before matching it (or
 * one a lookup failed for) gets another look on later scans, instead of
 * waiting for the nightly full scan; and the window moves on from when it
 * was asked for.
 */

const MIN = 60 * 1000;

const movie = (guid: string, extra: Partial<PlexLibraryItem> = {}) =>
  ({
    ratingKey: '501',
    title: 'Blood',
    guid,
    addedAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    type: 'movie',
    Media: [],
    ...extra,
  }) as PlexLibraryItem;

describe('another look at what the recently added scan could not place', () => {
  it('tries again less often each time, and gives up after a day', () => {
    const retries = new RecentRetries();
    const item = movie('local://501');
    const t0 = 1_000_000;
    assert.equal(
      retries.failed('1', item, 'Unable to find TMDB ID', t0),
      false
    );
    assert.deepEqual(retries.due('1', t0 + 4 * MIN), []);
    assert.equal(retries.due('1', t0 + 5 * MIN).length, 1);

    // Then 10 minutes, 20, 40 … never more than two hours apart.
    retries.failed('1', item, 'still', t0 + 5 * MIN);
    assert.deepEqual(retries.due('1', t0 + 14 * MIN), []);
    assert.equal(retries.due('1', t0 + 15 * MIN).length, 1);
    for (let i = 0; i < 10; i++)
      retries.failed('1', item, 'still', t0 + 6 * MIN);
    assert.equal(retries.due('1', t0 + 6 * MIN + 120 * MIN).length, 1);

    assert.equal(retries.failed('1', item, 'still', t0 + RETRY_FOR_MS), true);
    assert.equal(retries.count('1'), 0);
  });

  it('keeps one entry per title, a show for all its episodes', () => {
    const retries = new RecentRetries();
    const episode = (key: string) =>
      ({
        ...movie('local://x'),
        type: 'episode',
        ratingKey: key,
        grandparentRatingKey: '900',
      }) as PlexLibraryItem;
    retries.failed('2', episode('901'), 'no match');
    retries.failed('2', episode('902'), 'no match');
    assert.equal(retries.count('2'), 1);
    retries.succeeded('2', episode('903'));
    assert.equal(retries.count('2'), 0);
  });
});

describe('the recently added scan', () => {
  let now = 1_800_000_000_000;
  let added: PlexLibraryItem[] = [];
  let matched: PlexLibraryItem | null = null;
  let asked: number[] = [];
  let processed: string[] = [];

  beforeEach(() => {
    now = 1_800_000_000_000;
    added = [];
    matched = null;
    asked = [];
    processed = [];
    plexRecentScanner.retries.clear();
    mock.timers.enable({ apis: ['Date'], now });
    const settings = getSettings();
    settings.plex = {
      ...settings.plex,
      libraries: [
        { id: '1', name: 'Movies', enabled: true, type: 'movie', lastScan: 0 },
      ],
    };
    mock.method(settings, 'save', async () => undefined);
    mock.method(PlexAPI.prototype, 'getLibraries', async () => []);
    mock.method(
      PlexAPI.prototype,
      'getRecentlyAdded',
      async (_id: string, options?: { addedAt: number }) => {
        asked.push(options?.addedAt ?? -1);
        return added;
      }
    );
    mock.method(PlexAPI.prototype, 'getMetadata', async () => matched);
    // Placing a title: one Plex has matched works; an unmatched one does
    // not, as the scanner's own lookup would find no TMDB id.
    mock.method(
      Object.getPrototypeOf(plexRecentScanner),
      'processItem',
      async (item: PlexLibraryItem) => {
        processed.push(item.guid);
        return item.guid.startsWith('local://')
          ? 'Unable to find TMDB ID'
          : null;
      }
    );
  });

  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  const scan = async (at: number) => {
    now = at;
    mock.timers.setTime(at);
    await plexRecentScanner.run();
  };

  it('looks again at a title Plex added before matching it', async () => {
    added = [movie('local://501')];
    await scan(now);
    assert.deepEqual(processed, ['local://501']);
    assert.equal(plexRecentScanner.retries.count('1'), 1);
    assert.equal(getSettings().plex.libraries[0].lastScan, now);

    // Plex has matched it since; the window has moved past it.
    added = [];
    matched = movie('plex://movie/abc', {
      Guid: [{ id: 'tmdb://84773' }],
    });
    const first = now;
    await scan(first + 3 * 60 * 1000);
    assert.deepEqual(processed, ['local://501'], 'not yet due');
    await scan(first + 6 * 60 * 1000);
    assert.deepEqual(processed, ['local://501', 'plex://movie/abc']);
    assert.equal(plexRecentScanner.retries.count('1'), 0);
  });

  it('leaves a library switched off while it scans', async () => {
    const settings = getSettings();
    settings.plex = {
      ...settings.plex,
      libraries: [
        { id: '1', name: 'Movies', enabled: true, type: 'movie', lastScan: 0 },
        { id: '3', name: 'Anime', enabled: true, type: 'show', lastScan: 0 },
      ],
    };
    const libraries: string[] = [];
    mock.method(PlexAPI.prototype, 'getRecentlyAdded', async (id: string) => {
      libraries.push(id);
      // Switched off in Settings while Movies is being scanned.
      settings.plex.libraries = settings.plex.libraries.map((l) =>
        l.id === '3' ? { ...l, enabled: false } : l
      );
      return [];
    });
    await scan(now);
    assert.deepEqual(libraries, ['1']);
  });

  it('moves the window on from when it asked, with ten minutes to spare', async () => {
    const first = now;
    await scan(first);
    await scan(first + 5 * 60 * 1000);
    assert.deepEqual(asked, [-1, first - 10 * 60 * 1000]);
    assert.equal(
      getSettings().plex.libraries[0].lastScan,
      first + 5 * 60 * 1000
    );
  });
});
