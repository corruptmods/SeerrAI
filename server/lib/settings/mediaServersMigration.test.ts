import { MediaServerType } from '@server/constants/server';
import type { AllSettings } from '@server/lib/settings';
import migrateMediaServers from '@server/lib/settings/migrations/0010_media_servers';
import { runMigrations } from '@server/lib/settings/migrator';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

/*
 * Settings migration 0010: each media server says whether Seerr is
 * connected to it, and Emby gets its own settings, for every kind of
 * existing install.
 */

const jellyfinBlock = {
  name: 'Den',
  ip: '192.168.1.20',
  port: 8096,
  useSsl: false,
  urlBase: '',
  externalHostname: 'https://watch.example.com',
  jellyfinForgotPasswordUrl: 'https://watch.example.com/forgot',
  libraries: [{ id: 'lib1', name: 'Films', enabled: true, type: 'movie' }],
  serverId: 'server-1',
  apiKey: 'the-api-key',
};

const emptyJellyfin = {
  name: '',
  ip: '',
  port: 8096,
  useSsl: false,
  urlBase: '',
  externalHostname: '',
  jellyfinForgotPasswordUrl: '',
  libraries: [],
  serverId: '',
  apiKey: '',
};

/** settings.json as an install of this kind has it before the migration. */
const install = (
  type: MediaServerType,
  { mediaServerLogin = true }: { mediaServerLogin?: boolean } = {}
) => ({
  main: { mediaServerType: type, mediaServerLogin },
  plex:
    type === MediaServerType.PLEX
      ? {
          name: 'Plex Box',
          ip: '192.168.1.10',
          port: 32400,
          machineId: 'machine',
          libraries: [],
        }
      : { name: '', ip: '', port: 32400, libraries: [] },
  jellyfin:
    type === MediaServerType.JELLYFIN || type === MediaServerType.EMBY
      ? { ...jellyfinBlock }
      : { ...emptyJellyfin },
  jobs: {
    'jellyfin-recently-added-scan': { schedule: '0 */10 * * * *' },
    'jellyfin-full-scan': { schedule: '0 0 2 * * *' },
  },
  // The migrations that read the database have run on any install this old.
  migrations: [
    '0007_migrate_arr_tags',
    '0008_migrate_blacklist_to_blocklist',
    '0009_maintainerr_servers',
  ],
});

const migrate = (settings: unknown) =>
  migrateMediaServers(structuredClone(settings)) as AllSettings & {
    pendingEmbySplit?: boolean;
  };

describe('settings migration 0010 (media servers)', () => {
  it('connects Plex on a Plex install, its sign-in following the old switch', () => {
    const after = migrate(install(MediaServerType.PLEX));
    assert.equal(after.plex.connected, true);
    assert.equal(after.plex.signIn, true);
    assert.equal(after.plex.machineId, 'machine');
    assert.equal(after.jellyfin.connected, false);
    assert.equal(after.emby.connected, false);
    assert.equal(after.emby.apiKey, '');
    assert.equal(after.pendingEmbySplit, undefined);
    assert.ok(after.migrations.includes('0010_media_servers'));

    const noSignIn = migrate(
      install(MediaServerType.PLEX, { mediaServerLogin: false })
    );
    assert.equal(noSignIn.plex.signIn, false);
  });

  it('connects Jellyfin on a Jellyfin install and leaves its settings', () => {
    const after = migrate(
      install(MediaServerType.JELLYFIN, { mediaServerLogin: false })
    );
    assert.deepEqual(
      { ...after.jellyfin, connected: undefined, signIn: undefined },
      // Filled in from a new server's defaults, music libraries included.
      {
        ...jellyfinBlock,
        musicLibraries: [],
        connected: undefined,
        signIn: undefined,
      }
    );
    assert.equal(after.jellyfin.connected, true);
    assert.equal(after.jellyfin.signIn, false);
    assert.equal(after.plex.connected, false);
    assert.equal(after.emby.connected, false);
    assert.equal(after.emby.ip, '');
    assert.equal(after.pendingEmbySplit, undefined);
    assert.equal(
      (after.jobs as Record<string, unknown>)['emby-recently-added-scan'],
      undefined,
      "Jellyfin's schedules are not copied to Emby"
    );
  });

  it("moves an Emby install's settings and schedules to Emby's own", () => {
    const after = migrate(install(MediaServerType.EMBY));
    assert.equal(after.emby.connected, true);
    assert.equal(after.emby.signIn, true);
    assert.equal(after.emby.ip, '192.168.1.20');
    assert.equal(after.emby.apiKey, 'the-api-key');
    assert.equal(after.emby.serverId, 'server-1');
    assert.equal(after.emby.externalHostname, 'https://watch.example.com');
    assert.deepEqual(after.emby.libraries, jellyfinBlock.libraries);

    assert.equal(after.jellyfin.connected, false);
    assert.equal(after.jellyfin.ip, '');
    assert.equal(after.jellyfin.apiKey, '');
    assert.deepEqual(after.jellyfin.libraries, []);
    assert.equal(after.plex.connected, false);

    const jobs = after.jobs as Record<string, { schedule: string }>;
    assert.equal(jobs['emby-recently-added-scan'].schedule, '0 */10 * * * *');
    assert.equal(jobs['emby-full-scan'].schedule, '0 0 2 * * *');
    assert.equal(
      jobs['jellyfin-recently-added-scan'].schedule,
      '0 */10 * * * *',
      'existing schedules are not changed'
    );

    assert.equal(after.pendingEmbySplit, true);
    assert.equal(after.main.mediaServerType, MediaServerType.EMBY);
  });

  it('connects nothing before setup', () => {
    const after = migrate(install(MediaServerType.NOT_CONFIGURED));
    assert.equal(after.plex.connected, false);
    assert.equal(after.jellyfin.connected, false);
    assert.equal(after.emby.connected, false);
    assert.equal(after.pendingEmbySplit, undefined);
  });

  it('runs once: a second run changes nothing, for every install', () => {
    for (const type of [
      MediaServerType.PLEX,
      MediaServerType.JELLYFIN,
      MediaServerType.EMBY,
      MediaServerType.NOT_CONFIGURED,
    ]) {
      const once = migrate(install(type));
      const twice = migrate(once);
      assert.deepEqual(twice, once, MediaServerType[type]);
    }
    // In particular, an Emby install's settings are not overwritten by the
    // Jellyfin block it left empty.
    const emby = migrate(migrate(install(MediaServerType.EMBY)));
    assert.equal(emby.emby.apiKey, 'the-api-key');
  });
});

describe('settings migrations run at startup', () => {
  const dirs: string[] = [];
  const jellyfinType = process.env.JELLYFIN_TYPE;

  afterEach(async () => {
    if (jellyfinType === undefined) {
      delete process.env.JELLYFIN_TYPE;
    } else {
      process.env.JELLYFIN_TYPE = jellyfinType;
    }
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  const runAll = async (settings: unknown) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-settings-'));
    dirs.push(dir);
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, JSON.stringify(settings));
    const migrated = await runMigrations(
      structuredClone(settings) as AllSettings,
      file
    );
    return {
      migrated: migrated as AllSettings & { pendingEmbySplit?: boolean },
      saved: JSON.parse(await fs.readFile(file, 'utf-8')),
    };
  };

  it('gives Emby its settings when JELLYFIN_TYPE made the install Emby', async () => {
    process.env.JELLYFIN_TYPE = 'emby';
    // An old install recorded Emby as Jellyfin, told apart by JELLYFIN_TYPE
    // (migration 0003), which runs first.
    const { migrated, saved } = await runAll(install(MediaServerType.JELLYFIN));
    assert.equal(migrated.main.mediaServerType, MediaServerType.EMBY);
    assert.equal(migrated.emby.apiKey, 'the-api-key');
    assert.equal(migrated.emby.connected, true);
    assert.equal(migrated.jellyfin.apiKey, '');
    assert.equal(migrated.pendingEmbySplit, true);
    assert.deepEqual(saved, migrated, 'the migrated settings are saved');
  });

  it('leaves a migrated Plex install as it is on the next start', async () => {
    const { migrated } = await runAll(install(MediaServerType.PLEX));
    const again = await runAll(migrated);
    assert.deepEqual(again.migrated, migrated);
  });
});
