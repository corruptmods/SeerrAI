import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { siloDefaults } from '@server/lib/settings';
import migrateSiloDefaults from '@server/lib/settings/migrations/0020_silo_defaults';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (settings: any) => migrateSiloDefaults(settings) as any;

describe('the Silo defaults migration', () => {
  it('gives settings saved before Silo its unconfigured defaults', () => {
    const after = run({ main: { mediaServerType: MediaServerType.EMBY } });
    assert.deepEqual(after.silo, siloDefaults());
    assert.equal(after.silo.connected, false);
    assert.equal(after.silo.port, 8090);
    assert.equal(after.main.mediaServerType, MediaServerType.EMBY);
  });

  it('keeps a configured Silo and only repairs its library lists', () => {
    const after = run({
      silo: {
        name: 'Glasswing',
        ip: 'silo.local',
        port: 8090,
        apiKey: 'sa_x',
        connected: true,
        libraries: [{ id: '1', name: 'Films', enabled: true, type: 'movie' }],
        musicLibraries: [{ id: '9', name: 'Odd', enabled: true }],
      },
    });
    assert.equal(after.silo.name, 'Glasswing');
    assert.equal(after.silo.connected, true);
    assert.equal(after.silo.libraries.length, 1);
    assert.deepEqual(after.silo.musicLibraries, []);
    assert.equal(run({ silo: { name: 'x' } }).silo.libraries.length, 0);
  });

  it('never shifts the stored server and account type numbers', () => {
    assert.equal(MediaServerType.PLEX, 1);
    assert.equal(MediaServerType.JELLYFIN, 2);
    assert.equal(MediaServerType.EMBY, 3);
    assert.equal(MediaServerType.NOT_CONFIGURED, 4);
    assert.equal(MediaServerType.SILO, 5);
    assert.equal(UserType.EMBY, 4);
    assert.equal(UserType.SILO, 5);
  });
});
