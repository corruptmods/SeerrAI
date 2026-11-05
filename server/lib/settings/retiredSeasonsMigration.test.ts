import { MediaServerType } from '@server/constants/server';
import type { AllSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import removeRetiredSeasons from '@server/lib/settings/migrations/0013_remove_retired_seasons';
import { runMigrations } from '@server/lib/settings/migrator';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

// Migration 0013: settings with the retired Diwali and Pride Month seasons load
// and drop them.

/** Seasons as saved with Diwali and Pride Month. */
const before = () => ({
  halloween: { enabled: true, start: '10-20', end: '11-01' },
  holidays: { enabled: false, start: '12-01', end: '12-28' },
  newyear: { enabled: true, start: '12-29', end: '01-02' },
  lunarnewyear: { enabled: true },
  diwali: { enabled: true },
  pride: { enabled: true, start: '06-01', end: '06-30' },
});

/** The same seasons after migration. */
const after = () => ({
  halloween: { enabled: true, start: '10-20', end: '11-01' },
  holidays: { enabled: false, start: '12-01', end: '12-28' },
  newyear: { enabled: true, start: '12-29', end: '01-02' },
  lunarnewyear: { enabled: true },
});

/** An up-to-date settings file except for its seasons. */
const install = (appearance: unknown) => ({
  main: {
    mediaServerType: MediaServerType.PLEX,
    discoverRegion: '',
    streamingRegion: 'US',
  },
  network: {},
  appearance,
  migrations: [
    '0007_migrate_arr_tags',
    '0008_migrate_blacklist_to_blocklist',
    '0009_maintainerr_servers',
    '0010_media_servers',
    '0011_anime_excluded_countries',
  ],
});

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** Runs all migrations on a settings file, as startup does. */
const start = async (settings: unknown) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-settings-'));
  dirs.push(dir);
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, JSON.stringify(settings));
  const migrated = await runMigrations(
    structuredClone(settings) as AllSettings,
    file
  );
  return { migrated, saved: JSON.parse(await fs.readFile(file, 'utf-8')) };
};

describe('settings migration 0013 (Diwali and Pride Month)', () => {
  it('drops the two seasons and keeps the others as they were', () => {
    const migrated = removeRetiredSeasons(
      structuredClone({
        appearance: { default: { accent: 'teal' }, seasons: before() },
      }) as unknown as AllSettings
    );
    assert.deepEqual(migrated.appearance, {
      default: { accent: 'teal' },
      seasons: after(),
    });
  });

  it('drops them whatever was saved for them', () => {
    const migrated = removeRetiredSeasons(
      structuredClone({
        appearance: { seasons: { diwali: 'on', pride: null } },
      }) as unknown as AllSettings
    );
    assert.deepEqual(migrated.appearance, { seasons: {} });
  });

  it('leaves settings without them alone', () => {
    for (const settings of [
      {},
      { appearance: null },
      { appearance: {} },
      { appearance: { seasons: null } },
      { appearance: { seasons: 'nonsense' } },
      { appearance: { seasons: after() } },
    ]) {
      assert.deepEqual(
        removeRetiredSeasons(
          structuredClone(settings) as unknown as AllSettings
        ),
        settings
      );
    }
  });

  it('loads an older settings file and saves it without them', async () => {
    const { migrated, saved } = await start(install({ seasons: before() }));
    assert.deepEqual(migrated.appearance.seasons, after());
    assert.deepEqual(saved, migrated, 'the trimmed settings are saved');

    // At run time, pages see only the remaining seasons.
    const settings = getSettings();
    const { seasons } = settings.appearance;
    settings.appearance.seasons = migrated.appearance.seasons;
    try {
      assert.deepEqual(
        settings.fullPublicSettings.seasons.map((season) => season.id),
        ['halloween', 'newyear', 'lunarnewyear']
      );
    } finally {
      settings.appearance.seasons = seasons;
    }
  });

  it('is not needed twice', async () => {
    const { migrated } = await start(install({ seasons: before() }));
    const again = await start(migrated);
    assert.deepEqual(again.migrated, migrated);
  });
});
