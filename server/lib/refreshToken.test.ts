import PlexTvAPI from '@server/api/plextv';
import { MediaServerType } from '@server/constants/server';
import refreshToken from '@server/lib/refreshToken';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

/*
 * Plex sign-ins are kept alive by pinging Plex with each person's token,
 * only while Seerr is connected to Plex.
 */

setupTestDb();

afterEach(() => {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.NOT_CONFIGURED;
  settings.plex.connected = false;
  mock.restoreAll();
});

describe('Plex Refresh Token', () => {
  it('keeps each Plex sign-in alive while Plex is connected', async () => {
    getSettings().main.mediaServerType = MediaServerType.JELLYFIN;
    getSettings().plex.connected = true;
    const pinged = mock.method(PlexTvAPI.prototype, 'pingToken', async () => {
      return;
    });

    await refreshToken.run();

    // The two people the test database starts with.
    assert.equal(pinged.mock.callCount(), 2);
  });

  it('asks Plex nothing while Seerr is not connected to it', async () => {
    getSettings().main.mediaServerType = MediaServerType.JELLYFIN;
    getSettings().plex.connected = false;
    const pinged = mock.method(PlexTvAPI.prototype, 'pingToken', async () => {
      return;
    });

    await refreshToken.run();

    assert.equal(pinged.mock.callCount(), 0);
  });
});
