import JellyfinAPI from '@server/api/jellyfin';
import type { AxiosInstance } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

const episodesFrom = (items: Record<string, string>[]) => {
  const jellyfin = new JellyfinAPI('http://jellyfin.invalid:8096');
  mock.method(
    (jellyfin as unknown as { axios: AxiosInstance }).axios,
    'get',
    async () => ({ data: { Items: items } })
  );
  return jellyfin;
};

describe("a Jellyfin season's episodes", () => {
  afterEach(() => mock.restoreAll());

  it('leaves out specials airing within it, and missing episodes', async () => {
    const jellyfin = episodesFrom([
      {
        Id: 'e1',
        SeasonId: '0F8FAD5B-D9CB-469F-A165-70867728950E',
        LocationType: 'FileSystem',
      },
      {
        Id: 'special',
        SeasonId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        LocationType: 'FileSystem',
      },
      // The same season, as Emby may write its id.
      {
        Id: 'e2',
        SeasonId: '0f8fad5bd9cb469fa16570867728950e',
        LocationType: 'FileSystem',
      },
      {
        Id: 'missing',
        SeasonId: '0f8fad5b-d9cb-469f-a165-70867728950e',
        LocationType: 'Virtual',
      },
      // Older servers send no SeasonId.
      { Id: 'e3', LocationType: 'FileSystem' },
    ]);
    assert.deepEqual(
      (
        await jellyfin.getEpisodes(
          'series',
          '0f8fad5b-d9cb-469f-a165-70867728950e'
        )
      ).map((e) => e.Id),
      ['e1', 'e2', 'e3']
    );
  });
});
