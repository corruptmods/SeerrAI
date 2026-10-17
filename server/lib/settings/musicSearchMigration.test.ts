import { MediaServerType } from '@server/constants/server';
import type { AllSettings } from '@server/lib/settings';
import { getSettings, musicDefaults } from '@server/lib/settings';
import trimMusicSearch from '@server/lib/settings/migrations/0012_trim_music_search';
import { runMigrations } from '@server/lib/settings/migrator';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

/*
 * Settings migration 0012: Settings → Music kept where music could be
 * searched and how much a search showed. Only "in All" is left; a settings
 * file saved before still loads, and loses the rest.
 */

/** Music's settings as the version with the longer Music tab saved them. */
const before = () => ({
  musicbrainzUrl: 'http://192.168.1.5:5000',
  contactEmail: 'admin@example.com',
  listenBrainz: false,
  theAudioDbApiKey: 'secret',
  maxAlbumsPerRequest: 50,
  search: {
    inAll: true,
    musicPage: false,
    chip: false,
    artists: 3,
    albums: 20,
  },
});

/** A settings file from an up-to-date install but for music's search. */
const install = (music: unknown) => ({
  main: {
    mediaServerType: MediaServerType.PLEX,
    discoverRegion: '',
    streamingRegion: 'US',
  },
  network: {},
  music,
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

/** Runs every migration on a settings file, as starting Seerr AI does. */
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

describe('settings migration 0012 (music search)', () => {
  it('keeps whether music is in All and drops the rest', () => {
    const migrated = trimMusicSearch(
      structuredClone({ music: before() }) as unknown as AllSettings
    );
    assert.deepEqual(migrated.music, {
      ...before(),
      search: { inAll: true },
    });
  });

  it('leaves settings without them alone', () => {
    for (const settings of [
      {},
      { music: { listenBrainz: true } },
      { music: { ...before(), search: { inAll: false } } },
    ]) {
      assert.deepEqual(
        trimMusicSearch(structuredClone(settings) as unknown as AllSettings),
        settings
      );
    }
  });

  it('loads an older settings file and saves it without them', async () => {
    const { migrated, saved } = await start(install(before()));
    assert.deepEqual(migrated.music.search, { inAll: true });
    assert.deepEqual(saved, migrated, 'the trimmed settings are saved');

    // Running with them: the Music tab, music search and everyone's pages
    // see only what is left, and that is all a save writes.
    const settings = getSettings();
    settings.music = migrated.music;
    assert.deepEqual(settings.music.search, { inAll: true });
    assert.equal(settings.music.theAudioDbApiKey, 'secret');
    assert.equal(settings.music.maxAlbumsPerRequest, 50);
    assert.deepEqual(settings.fullPublicSettings.musicSearch, { inAll: true });
    assert.deepEqual(JSON.parse(JSON.stringify(settings.music)).search, {
      inAll: true,
    });
    settings.music = musicDefaults();
  });

  it('is not needed twice', async () => {
    const { migrated } = await start(install(before()));
    const again = await start(migrated);
    assert.deepEqual(again.migrated, migrated);
  });
});
