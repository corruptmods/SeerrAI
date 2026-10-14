import { MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { getSettings, jellyfinDefaults } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

setupTestDb();

/*
 * Where a title can be played: a link per connected server that has it,
 * and the single links API readers have always had (mediaUrl, iOSPlexUrl,
 * tautulliUrl), built exactly as before for the primary server.
 */

beforeEach(() => {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.NOT_CONFIGURED;
  settings.plex = {
    ...settings.plex,
    machineId: 'machine-1',
    webAppUrl: '',
    connected: false,
  };
  settings.tautulli = { ...settings.tautulli, externalUrl: '' };
  settings.jellyfin = {
    ...jellyfinDefaults(),
    ip: 'jellyfin.lan',
    port: 8096,
    serverId: 'jf-server',
  };
  settings.emby = {
    ...jellyfinDefaults(),
    ip: 'emby.lan',
    port: 8096,
    externalHostname: 'https://emby.example.com',
    serverId: 'emby-server',
  };
});

const title = () =>
  new Media({
    tmdbId: 603,
    mediaType: MediaType.MOVIE,
    ratingKey: '111',
    ratingKey4k: '222',
    jellyfinMediaId: 'jf-1',
    embyMediaId: 'em-1',
    embyMediaId4k: 'em-4k',
  });

describe('play links', () => {
  it('keeps the Plex links of a Plex server exactly as they were', () => {
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.PLEX;
    settings.tautulli.externalUrl = 'https://tautulli.example.com';
    const media = title();
    media.setPlayLinks();

    assert.equal(
      media.mediaUrl,
      'https://app.plex.tv/desktop#!/server/machine-1/details?key=%2Flibrary%2Fmetadata%2F111'
    );
    assert.equal(
      media.iOSPlexUrl,
      'plex://preplay/?metadataKey=%2Flibrary%2Fmetadata%2F111&server=machine-1'
    );
    assert.equal(
      media.mediaUrl4k,
      'https://app.plex.tv/desktop#!/server/machine-1/details?key=%2Flibrary%2Fmetadata%2F222'
    );
    assert.equal(
      media.iOSPlexUrl4k,
      'plex://preplay/?metadataKey=%2Flibrary%2Fmetadata%2F222&server=machine-1'
    );
    assert.equal(
      media.tautulliUrl,
      'https://tautulli.example.com/info?rating_key=111'
    );
    assert.equal(
      media.tautulliUrl4k,
      'https://tautulli.example.com/info?rating_key=222'
    );
    // Only connected servers get a link, whatever ids the title has.
    assert.deepEqual(media.playLinks, [
      {
        server: 'plex',
        name: 'Plex',
        url: media.mediaUrl,
        iosUrl: media.iOSPlexUrl,
        url4k: media.mediaUrl4k,
        iosUrl4k: media.iOSPlexUrl4k,
      },
    ]);

    settings.plex.webAppUrl = 'https://plex.example.com/web';
    const own = title();
    own.setPlayLinks();
    assert.equal(
      own.mediaUrl,
      'https://plex.example.com/web#!/server/machine-1/details?key=%2Flibrary%2Fmetadata%2F111'
    );
  });

  it("links a Jellyfin server's details page", () => {
    getSettings().main.mediaServerType = MediaServerType.JELLYFIN;
    const media = title();
    media.setPlayLinks();
    assert.equal(
      media.mediaUrl,
      'http://jellyfin.lan:8096/web/index.html#!/details?id=jf-1&context=home&serverId=jf-server'
    );
    assert.equal(media.mediaUrl4k, undefined);
    assert.equal(media.iOSPlexUrl, undefined);
    assert.deepEqual(media.playLinks, [
      { server: 'jellyfin', name: 'Jellyfin', url: media.mediaUrl },
    ]);
  });

  it("links an Emby server's item page from Emby's own ids and address", () => {
    getSettings().main.mediaServerType = MediaServerType.EMBY;
    const media = title();
    media.setPlayLinks();
    assert.equal(
      media.mediaUrl,
      'https://emby.example.com/web/index.html#!/item?id=em-1&context=home&serverId=emby-server'
    );
    assert.equal(
      media.mediaUrl4k,
      'https://emby.example.com/web/index.html#!/item?id=em-4k&context=home&serverId=emby-server'
    );
    assert.deepEqual(
      media.playLinks?.map((link) => link.server),
      ['emby']
    );
  });

  it('lists each connected server, keeping the single links for the primary', () => {
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.PLEX;
    settings.emby.connected = true;
    const media = title();
    media.setPlayLinks();
    assert.deepEqual(
      media.playLinks?.map((link) => [link.server, link.url]),
      [
        [
          'plex',
          'https://app.plex.tv/desktop#!/server/machine-1/details?key=%2Flibrary%2Fmetadata%2F111',
        ],
        [
          'emby',
          'https://emby.example.com/web/index.html#!/item?id=em-1&context=home&serverId=emby-server',
        ],
      ]
    );
    assert.match(media.mediaUrl ?? '', /^https:\/\/app\.plex\.tv/);

    // A connected server that does not have the title has no link.
    const plexOnly = new Media({
      tmdbId: 1,
      mediaType: MediaType.MOVIE,
      ratingKey: '5',
    });
    plexOnly.setPlayLinks();
    assert.deepEqual(
      plexOnly.playLinks?.map((link) => link.server),
      ['plex']
    );
  });

  it('are there on a title read from the database', async () => {
    getSettings().main.mediaServerType = MediaServerType.EMBY;
    await getRepository(Media).save(title());
    const media = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 603, mediaType: MediaType.MOVIE },
    });
    assert.equal(
      media.mediaUrl,
      'https://emby.example.com/web/index.html#!/item?id=em-1&context=home&serverId=emby-server'
    );
    assert.equal(media.playLinks?.length, 1);
  });
});
