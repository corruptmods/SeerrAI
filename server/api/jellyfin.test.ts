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

describe('libraries when /Library/MediaFolders is refused', () => {
  afterEach(() => mock.restoreAll());

  const USER = '4f1c2d3e5a6b7c8d9e0f1a2b3c4d5e6f';

  const refused = (status: number) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status },
    });

  /** A server answering only `answers`, refusing the rest with a 403. */
  const serverWith = (
    kind: 'jellyfin' | 'emby',
    answers: Record<string, unknown>,
    asked: string[]
  ) => {
    const api = new JellyfinAPI('http://media.invalid:8096', 't', 'd', kind);
    api.setUserId(USER);
    mock.method(
      (api as unknown as { axios: AxiosInstance }).axios,
      'get',
      async (url: string) => {
        asked.push(url);
        const answer = answers[url];
        if (answer instanceof Error) throw answer;
        if (answer === undefined) throw refused(403);
        return { data: answer };
      }
    );
    return api;
  };

  const folder = (Name: string) => ({
    Id: `${Name.replace(/ /g, '')}Id`,
    Name,
    Type: 'CollectionFolder',
    CollectionType: 'movies',
  });

  it('uses Jellyfin’s /UserViews for the signed-in user', async () => {
    const asked: string[] = [];
    const api = serverWith(
      'jellyfin',
      { [`/UserViews?userId=${USER}`]: { Items: [folder('Glasswing')] } },
      asked
    );
    assert.deepEqual(
      (await api.getLibraries()).map((l) => l.title),
      ['Glasswing']
    );
    assert.deepEqual(asked, [
      '/Library/MediaFolders',
      `/UserViews?userId=${USER}`,
    ]);
  });

  it('falls back to /Users/{id}/Views on a Jellyfin without /UserViews', async () => {
    const asked: string[] = [];
    const api = serverWith(
      'jellyfin',
      {
        [`/UserViews?userId=${USER}`]: refused(404),
        [`/Users/${USER}/Views`]: { Items: [folder('Static Garden')] },
      },
      asked
    );
    assert.deepEqual(
      (await api.getLibraries()).map((l) => l.title),
      ['Static Garden']
    );
    assert.equal(asked.length, 3);
  });

  it('keeps Emby on /Users/{id}/Views', async () => {
    const asked: string[] = [];
    const api = serverWith(
      'emby',
      { [`/Users/${USER}/Views`]: { Items: [folder('Lantern Song')] } },
      asked
    );
    assert.deepEqual(
      (await api.getLibraries()).map((l) => l.title),
      ['Lantern Song']
    );
    assert.deepEqual(asked, ['/Library/MediaFolders', `/Users/${USER}/Views`]);
  });

  it('lists none when every route is refused, and stops when unreachable', async () => {
    const asked: string[] = [];
    assert.deepEqual(
      await serverWith('jellyfin', {}, asked).getLibraries(),
      []
    );
    assert.equal(asked.length, 3);

    const gone: string[] = [];
    const down = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    await assert.rejects(
      serverWith(
        'jellyfin',
        {
          '/Library/MediaFolders': down,
          [`/UserViews?userId=${USER}`]: down,
        },
        gone
      ).getLibraries()
    );
    assert.equal(gone.length, 2);
  });
});
