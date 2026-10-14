import JellyfinAPI from '@server/api/jellyfin';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import {
  connectAsPrimary,
  connectedServers,
  externalHostFor,
  hostnameFor,
  isConnected,
  jellyfinAccountColumns,
  jellyfinAccountOf,
  jellyfinAdmin,
  jellyfinClient,
  jellyfinFamily,
  jellyfinFamilyServer,
  kindOfUserType,
  linkedServers,
  primaryServer,
  serverName,
  signInAllowed,
} from '@server/lib/mediaServers';
import { getSettings, jellyfinDefaults } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

setupTestDb();

/*
 * Which media servers Seerr is connected to, and where each keeps its
 * settings and ids.
 */

const reset = () => {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.NOT_CONFIGURED;
  settings.main.mediaServerLogin = true;
  settings.plex.connected = false;
  settings.plex.signIn = true;
  settings.jellyfin = { ...jellyfinDefaults() };
  settings.emby = { ...jellyfinDefaults() };
};

beforeEach(reset);

describe('which servers are connected', () => {
  it('knows none before setup', () => {
    assert.equal(primaryServer(), undefined);
    assert.deepEqual(connectedServers(), []);
    assert.equal(jellyfinFamilyServer(), undefined);
    assert.equal(isConnected('plex'), false);
  });

  it('counts the primary server as connected, and lists it first', () => {
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.EMBY;
    assert.equal(primaryServer(), 'emby');
    assert.deepEqual(connectedServers(), ['emby']);
    assert.equal(isConnected('emby'), true);
    assert.equal(isConnected('jellyfin'), false);
    assert.equal(jellyfinFamilyServer(), 'emby');

    settings.plex.connected = true;
    settings.jellyfin.connected = true;
    assert.deepEqual(connectedServers(), ['emby', 'plex', 'jellyfin']);
    assert.equal(jellyfinFamilyServer(), 'emby', 'the primary one first');

    settings.main.mediaServerType = MediaServerType.PLEX;
    assert.deepEqual(connectedServers(), ['plex', 'jellyfin']);
    assert.equal(jellyfinFamilyServer(), 'jellyfin');
  });

  it('names each server as people know it', () => {
    assert.equal(serverName('plex'), 'Plex');
    assert.equal(serverName('jellyfin'), 'Jellyfin');
    assert.equal(serverName('emby'), 'Emby');
    assert.equal(kindOfUserType(UserType.EMBY), 'emby');
    assert.equal(kindOfUserType(UserType.JELLYFIN), 'jellyfin');
    assert.equal(kindOfUserType(UserType.PLEX), 'plex');
    assert.equal(kindOfUserType(UserType.LOCAL), undefined);
  });

  it('allows sign-in where the server is connected and its switch is on', () => {
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.JELLYFIN;
    assert.equal(signInAllowed('jellyfin'), true);
    assert.equal(signInAllowed('emby'), false, 'not connected');

    settings.jellyfin.signIn = false;
    assert.equal(signInAllowed('jellyfin'), false);

    settings.jellyfin.signIn = true;
    settings.main.mediaServerLogin = false;
    assert.equal(signInAllowed('jellyfin'), false, 'the one switch for all');
  });

  it('makes the server chosen at setup the connected primary one', () => {
    const settings = getSettings();
    settings.main.mediaServerLogin = false;
    connectAsPrimary('emby');
    assert.equal(settings.main.mediaServerType, MediaServerType.EMBY);
    assert.equal(settings.emby.connected, true);
    assert.equal(settings.emby.signIn, false);
    assert.equal(settings.jellyfin.connected, false);
  });
});

describe("each server's settings and addresses", () => {
  it("reads Jellyfin's and Emby's own settings", () => {
    const settings = getSettings();
    settings.jellyfin = {
      ...settings.jellyfin,
      ip: 'jellyfin.lan',
      port: 8096,
      urlBase: '/jf',
    };
    settings.emby = {
      ...settings.emby,
      ip: 'emby.lan',
      port: 8920,
      useSsl: true,
      urlBase: '',
      externalHostname: 'https://emby.example.com',
    };
    assert.equal(jellyfinFamily('emby').ip, 'emby.lan');
    assert.equal(hostnameFor('jellyfin'), 'http://jellyfin.lan:8096/jf');
    assert.equal(hostnameFor('emby'), 'https://emby.lan:8920');
    assert.equal(externalHostFor('emby'), 'https://emby.example.com');
    assert.equal(
      externalHostFor('jellyfin'),
      'http://jellyfin.lan:8096/jf',
      'the internal address when no external one is set'
    );
  });

  it('builds a client that knows which server it speaks to', async () => {
    const settings = getSettings();
    settings.emby = { ...settings.emby, ip: 'emby.lan', apiKey: 'emby-key' };
    const client = await jellyfinClient('emby');
    assert.ok(client instanceof JellyfinAPI);
    assert.equal(client.kind, 'emby');
    assert.equal((await jellyfinClient('jellyfin')).kind, 'jellyfin');
  });
});

describe("people's accounts on each server", () => {
  it('lists the servers someone has an account linked from', () => {
    assert.deepEqual(linkedServers({ plexId: 5 }), ['plex']);
    assert.deepEqual(
      linkedServers({ jellyfinUserId: 'j', embyUserId: 'e', plexId: null }),
      ['jellyfin', 'emby']
    );
    assert.deepEqual(linkedServers({}), []);
  });

  it("reads and writes an account in the server's own columns", () => {
    const columns = jellyfinAccountColumns('emby', {
      userId: 'e1',
      username: 'bob',
      deviceId: 'dev',
    });
    assert.deepEqual(columns, {
      embyUserId: 'e1',
      embyUsername: 'bob',
      embyDeviceId: 'dev',
    });
    const user = new User(columns);
    assert.deepEqual(jellyfinAccountOf(user, 'emby'), {
      userId: 'e1',
      username: 'bob',
      deviceId: 'dev',
      authToken: undefined,
    });
    assert.equal(jellyfinAccountOf(user, 'jellyfin').userId, undefined);
  });

  it('gives each user the servers they are linked from when loaded', async () => {
    const repository = getRepository(User);
    await repository.update(1, { embyUserId: 'e1', embyUsername: 'admin' });
    const owner = await repository.findOneOrFail({ where: { id: 1 } });
    assert.deepEqual(owner.linkedServers, ['plex', 'emby']);
  });

  it("reads a server as the owner's linked account, or the one chosen", async () => {
    const repository = getRepository(User);
    await repository.update(1, {
      embyUserId: 'owner-emby',
      embyDeviceId: 'owner-device',
    });
    assert.deepEqual(await jellyfinAdmin('emby'), {
      userId: 'owner-emby',
      deviceId: 'owner-device',
    });
    assert.deepEqual(await jellyfinAdmin('jellyfin'), {
      userId: '',
      deviceId: undefined,
    });

    getSettings().emby.adminUserId = 'chosen-admin';
    assert.deepEqual(await jellyfinAdmin('emby'), {
      userId: 'chosen-admin',
      deviceId: 'owner-device',
    });
  });
});
