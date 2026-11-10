import PlexListsAPI, {
  parseListPath,
  PlexListsError,
} from '@server/api/plexLists';
import type { AxiosInstance } from 'axios';
import { AxiosError, AxiosHeaders } from 'axios';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

/*
 * Replies shaped as Plex's own web app gets them (luma.plex.tv screens and
 * discover.provider.plex.tv metadata), trimmed to what matters.
 */

const summary = (id: string, slug: string, icon = 'user-private') => ({
  id,
  title: `List ${slug}`,
  subtitle: '4 Items',
  images: [],
  link: { url: `/u/Garden/lists/${slug}?context.page=watchlist.myLists` },
  privacy: { icon, label: 'Private' },
  actions: [],
});

const item = (id: string, path: string, year = '2026') => ({
  id,
  title: `Title ${id}`,
  subtitle: year,
  link: { url: `${path}?context.page=listDetail`, external: false },
});

const apiWith = (routes: Record<string, unknown>) => {
  const api = new PlexListsAPI('token');
  const axios = (api as unknown as { axios: AxiosInstance }).axios;
  const asked: string[] = [];
  mock.method(axios, 'get', async (path: string) => {
    asked.push(path);
    if (!(path in routes)) {
      throw new AxiosError('nope', '404', undefined, undefined, {
        status: 404,
        statusText: 'Not Found',
        data: {},
        headers: {},
        config: { headers: new AxiosHeaders() },
      });
    }
    return { data: routes[path] };
  });
  return { api, axios, asked };
};

describe('Plex Lists client', () => {
  it('reads list paths from Plex links', () => {
    assert.deepEqual(parseListPath('/u/Garden/lists/k7Qp-harbour-lights?x=1'), {
      owner: 'Garden',
      slug: 'k7Qp-harbour-lights',
    });
    assert.deepEqual(
      parseListPath('https://watch.plex.tv/u/Garden/lists/a1-glasswing'),
      { owner: 'Garden', slug: 'a1-glasswing' }
    );
    assert.equal(parseListPath('/movie/glasswing-2026'), undefined);
    assert.equal(parseListPath('https://example.com/u/a/lists/b'), undefined);
  });

  it("reads the person's lists with counts and privacy", async () => {
    const { api } = apiWith({
      '/api/screen/watchlist/my-lists': {
        ui: {
          lists: [
            summary('one', 'a1-glasswing'),
            summary('two', 'b2-static-garden', 'friends'),
          ],
          pagination: {},
        },
      },
    });
    assert.deepEqual(await api.getMyLists(), [
      {
        id: 'one',
        owner: 'Garden',
        slug: 'a1-glasswing',
        title: 'List a1-glasswing',
        itemCount: 4,
        privacy: 'PRIVATE',
      },
      {
        id: 'two',
        owner: 'Garden',
        slug: 'b2-static-garden',
        title: 'List b2-static-garden',
        itemCount: 4,
        privacy: 'FRIENDS',
      },
    ]);
  });

  it('reads a list over its pages, once per title, with what each is', async () => {
    const next = (cursor: string) =>
      `https://luma.plex.tv/api/fragment/community/custom-list?username=Garden&slug=a1-glasswing&cursor=${cursor}`;
    const { api, asked } = apiWith({
      '/api/screen/u/Garden/lists/a1-glasswing': {
        ui: {
          title: 'Glasswing',
          description: 'test',
          ranking: { selected: { value: true } },
          privacy: { selected: { value: 'PRIVATE' } },
          itemCountRaw: 4,
          list: [
            item('m1', '/movie/glasswing-2026'),
            item('s1', '/show/static-garden', '2022'),
          ],
          pagination: { nextUrl: next('Mg') },
        },
      },
      [new URL(next('Mg')).pathname + new URL(next('Mg')).search]: {
        content: [
          // The last title of a page can come again on the next.
          item('s1', '/show/static-garden', '2022'),
          item('e1', '/show/static-garden/season/1/episode/2'),
          item('m2', '/movie/lantern-song-2025', '2025'),
        ],
        pagination: {},
      },
    });
    const list = await api.getList('Garden', 'a1-glasswing');
    assert.equal(asked.length, 2);
    assert.equal(list.title, 'Glasswing');
    assert.equal(list.ranked, true);
    assert.equal(list.privacy, 'PRIVATE');
    assert.equal(list.truncated, false);
    assert.deepEqual(
      list.entries.map((e) => [e.plexId, e.kind, e.year]),
      [
        ['m1', 'movie', 2026],
        ['s1', 'show', 2022],
        ['e1', 'part', 2026],
        ['m2', 'movie', 2025],
      ]
    );
  });

  it("reads someone else's list as Plex shows it to them", async () => {
    const { api } = apiWith({
      '/api/screen/u/Garden/lists/a1-glasswing': {
        ui: {
          title: 'Glasswing',
          ranked: false,
          privacy: { icon: 'globe' },
          list: [],
        },
      },
    });
    const list = await api.getList('Garden', 'a1-glasswing');
    assert.equal(list.ranked, false);
    assert.equal(list.privacy, 'ANYONE');
  });

  it("doesn't follow a next page off luma.plex.tv", async () => {
    const { api, asked } = apiWith({
      '/api/screen/u/Garden/lists/a1-glasswing': {
        ui: {
          title: 'Glasswing',
          list: [item('m1', '/movie/glasswing-2026')],
          pagination: { nextUrl: 'https://example.com/steal?cursor=1' },
        },
      },
    });
    await assert.rejects(
      api.getList('Garden', 'a1-glasswing'),
      (e: unknown) => e instanceof PlexListsError && e.problem === 'changed'
    );
    assert.equal(asked.length, 1);
  });

  it('says Plex changed when a reply lacks what is needed', async () => {
    const { api } = apiWith({
      '/api/screen/u/Garden/lists/a1-glasswing': { ui: { title: 'x' } },
      // Lists to show, but none sent.
      '/api/screen/watchlist/my-lists': { ui: { listCount: '2 Lists' } },
    });
    for (const call of [
      api.getList('Garden', 'a1-glasswing'),
      api.getMyLists(),
    ]) {
      await assert.rejects(
        call,
        (e: unknown) => e instanceof PlexListsError && e.problem === 'changed'
      );
    }
  });

  it("leaves out an entry that isn't one of the person's lists", async () => {
    const { api } = apiWith({
      '/api/screen/watchlist/my-lists': {
        ui: {
          lists: [
            { ...summary('odd', 'x'), link: { url: '/watchlist' } },
            summary('one', 'a1-glasswing'),
          ],
        },
      },
    });
    assert.deepEqual(
      (await api.getMyLists()).map((list) => list.id),
      ['one']
    );
  });

  it('says a list was cut short when Plex holds more than it sent', async () => {
    const { api } = apiWith({
      '/api/screen/u/Garden/lists/a1-glasswing': {
        ui: {
          title: 'Glasswing',
          itemCountRaw: 3,
          list: [item('m1', '/movie/glasswing-2026')],
          pagination: {},
        },
      },
    });
    assert.equal((await api.getList('Garden', 'a1-glasswing')).truncated, true);
  });

  it('tells a refused sign-in from a missing list', async () => {
    const { api, axios } = apiWith({});
    await assert.rejects(
      api.getList('Garden', 'gone'),
      (e: unknown) => e instanceof PlexListsError && e.problem === 'missing'
    );
    mock.method(axios, 'get', async () => {
      throw new AxiosError('no', '401', undefined, undefined, {
        status: 401,
        statusText: 'Unauthorized',
        data: {},
        headers: {},
        config: { headers: new AxiosHeaders() },
      });
    });
    await assert.rejects(
      api.getMyLists(),
      (e: unknown) => e instanceof PlexListsError && e.problem === 'auth'
    );
  });

  it('finds TMDB ids, a season or episode giving its series', async () => {
    const metadata = (fields: Record<string, unknown>) => ({
      MediaContainer: { Metadata: [fields] },
    });
    const { api } = apiWith({
      '/library/metadata/m1': metadata({
        type: 'movie',
        Guid: [{ id: 'imdb://tt1' }, { id: 'tmdb://700101' }],
      }),
      '/library/metadata/e1': metadata({
        type: 'episode',
        grandparentRatingKey: 's1',
      }),
      '/library/metadata/s1': metadata({
        type: 'show',
        Guid: [{ id: 'tmdb://700202' }, { id: 'tvdb://800303' }],
      }),
      '/library/metadata/x1': metadata({ type: 'movie', Guid: [] }),
    });
    assert.deepEqual(await api.idsOf('m1'), {
      tmdbId: 700101,
      mediaType: 'movie',
      tvdbId: undefined,
    });
    assert.deepEqual(await api.idsOf('e1'), {
      tmdbId: 700202,
      mediaType: 'tv',
      tvdbId: 800303,
    });
    assert.equal(await api.idsOf('x1'), null);
    assert.equal(await api.idsOf('gone'), null);
  });

  it("finds Plex's id for a TMDB title", async () => {
    const { api } = apiWith({
      [`/library/metadata/matches?type=2&guid=${encodeURIComponent('tmdb://700202')}`]:
        {
          MediaContainer: {
            Metadata: [{ ratingKey: 's1', type: 'show' }],
          },
        },
    });
    assert.equal(await api.plexIdOf(700202, 'tv'), 's1');
  });

  it('adds to a list and starts one as Plex does', async () => {
    const { api, axios } = apiWith({});
    const posts: [string, unknown][] = [];
    mock.method(axios, 'post', async (path: string, body: unknown) => {
      posts.push([path, body]);
      return path === '/api/action/lists'
        ? {
            data: {
              stalePaths: [],
              ui: { link: { url: '/u/Garden/lists/6Hk6-harbour-lights' } },
            },
          }
        : { data: { stalePaths: [] } };
    });
    await api.editList('list-a', 'add', 'm1');
    assert.deepEqual(await api.createList('Harbour Lights', false), {
      owner: 'Garden',
      slug: '6Hk6-harbour-lights',
    });
    assert.deepEqual(posts, [
      [
        '/api/action/lists/list-a/edit-items',
        { changes: [{ add: { metadataId: 'm1' } }] },
      ],
      [
        '/api/action/lists',
        { title: 'Harbour Lights', privacy: 'PRIVATE', ranked: false },
      ],
    ]);
  });
});
