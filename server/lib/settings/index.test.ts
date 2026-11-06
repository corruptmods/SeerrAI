import { MediaServerType } from '@server/constants/server';
import type { AllSettings } from '@server/lib/settings';
import { getSettings, SETTINGS_PATH } from '@server/lib/settings';
import { runMigrations } from '@server/lib/settings/migrator';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

// Settings files hold every integration's keys: only Seerr's user reads them.

/** An up-to-date settings file, as the migration tests use. */
const installed = () => ({
  main: {
    mediaServerType: MediaServerType.PLEX,
    discoverRegion: '',
    streamingRegion: 'US',
  },
  network: {},
  appearance: {},
  migrations: [
    '0007_migrate_arr_tags',
    '0008_migrate_blacklist_to_blocklist',
    '0009_maintainerr_servers',
    '0010_media_servers',
    '0011_anime_excluded_countries',
  ],
});

const modeOf = async (file: string) => (await fs.stat(file)).mode & 0o777;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('settings files', { skip: process.platform === 'win32' }, () => {
  it('saves settings.json readable only by its owner', async () => {
    const file = SETTINGS_PATH;
    await fs.writeFile(file, '{}', { mode: 0o644 });
    await fs.chmod(file, 0o644);

    await getSettings().save();

    assert.equal(await modeOf(file), 0o600);
    await assert.rejects(fs.access(`${file}.tmp`), 'no copy is left behind');
  });

  it('writes the settings backup readable only by its owner', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-settings-'));
    dirs.push(dir);
    const file = path.join(dir, 'settings.json');
    const backup = path.join(dir, 'settings.old.json');
    await fs.writeFile(file, JSON.stringify(installed()), { mode: 0o644 });
    await fs.writeFile(backup, '{}', { mode: 0o644 });
    await fs.chmod(backup, 0o644);

    await runMigrations(installed() as unknown as AllSettings, file);

    assert.equal(await modeOf(backup), 0o600);
  });

  it('gives the Cypress settings fresh keys when they load', async () => {
    const fixture = path.join(
      process.cwd(),
      'cypress/config/settings.cypress.json'
    );
    const fixed = JSON.parse(await fs.readFile(fixture, 'utf-8'));
    assert.equal(fixed.main.apiKey, '');
    assert.equal(fixed.sessionSecret, undefined);
    assert.equal(fixed.vapidPrivate, undefined);

    const file = SETTINGS_PATH;
    await fs.copyFile(fixture, file);
    await getSettings().load(undefined, true);

    const saved = JSON.parse(await fs.readFile(file, 'utf-8'));
    assert.ok(saved.main.apiKey);
    assert.match(saved.sessionSecret, /^[0-9a-f]{64}$/);
    assert.ok(saved.vapidPrivate && saved.vapidPublic);
  });
});
