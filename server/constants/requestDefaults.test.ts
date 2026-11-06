import {
  cleanDefaultProfiles,
  cleanProfileFolders,
  mappedFolder,
} from '@server/constants/requestDefaults';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('saved default quality profiles', () => {
  it('keep one per server and kind, the last given', () => {
    assert.deepEqual(
      cleanDefaultProfiles([
        { service: 'radarr', serverId: 0, profileId: 4 },
        { service: 'radarr', serverId: 0, profileId: 6 },
        { service: 'radarr', serverId: 0, anime: true, profileId: 9 },
        { service: 'sonarr', serverId: 2, profileId: 3 },
      ]),
      [
        { service: 'radarr', serverId: 0, profileId: 6 },
        { service: 'radarr', serverId: 0, anime: true, profileId: 9 },
        { service: 'sonarr', serverId: 2, profileId: 3 },
      ]
    );
  });

  it('drop unknown services, odd ids and anime for music', () => {
    assert.deepEqual(
      cleanDefaultProfiles([
        { service: 'plex', serverId: 0, profileId: 1 },
        { service: 'radarr', serverId: -1, profileId: 1 },
        { service: 'radarr', serverId: 0, profileId: 0 },
        { service: 'sonarr', serverId: 1, profileId: 2.5 },
        { service: 'lidarr', serverId: 0, anime: true, profileId: 5 },
        null,
      ]),
      [{ service: 'lidarr', serverId: 0, profileId: 5 }]
    );
    assert.deepEqual(cleanDefaultProfiles('radarr'), []);
  });
});

describe('folders by quality profile', () => {
  it('keep one trimmed folder per profile, the last given', () => {
    assert.deepEqual(
      cleanProfileFolders([
        { profileId: 7, rootFolder: ' /anime ' },
        { profileId: 7, rootFolder: '/anime-uhd' },
        { profileId: 3, rootFolder: '/kids' },
        { profileId: 4, rootFolder: '   ' },
        { profileId: 0, rootFolder: '/none' },
        { rootFolder: '/no-profile' },
      ]),
      [
        { profileId: 7, rootFolder: '/anime-uhd' },
        { profileId: 3, rootFolder: '/kids' },
      ]
    );
    assert.deepEqual(cleanProfileFolders(undefined), []);
  });

  it('give the mapped folder of a profile, and nothing otherwise', () => {
    const server = { profileFolders: [{ profileId: 7, rootFolder: '/anime' }] };
    assert.equal(mappedFolder(server, 7), '/anime');
    assert.equal(mappedFolder(server, 8), undefined);
    assert.equal(mappedFolder(server, undefined), undefined);
    assert.equal(mappedFolder({}, 7), undefined);
    assert.equal(mappedFolder(undefined, 7), undefined);
  });
});
