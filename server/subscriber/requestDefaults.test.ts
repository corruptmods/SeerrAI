import type { AddSeriesOptions } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { Permission } from '@server/lib/permissions';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * A series sent to Sonarr without a quality profile goes with the requester's
 * saved one (their anime one for anime), and to the folder that profile maps
 * to when the request names none.
 */

setupTestDb();

const stub = (proto: object, name: string, value: unknown) =>
  Object.defineProperty(proto, name, {
    configurable: true,
    set() {},
    get() {
      return typeof value === 'function' ? value : async () => value;
    },
  });

let added: AddSeriesOptions[];
let requester: User;

const series = (id: number, anime: boolean) => ({
  id,
  name: anime ? 'Lantern Song' : 'Harbour Lights',
  first_air_date: '2021-04-01',
  external_ids: { tvdb_id: id + 1000 },
  seasons: [{ season_number: 1, episode_count: 8 }],
  keywords: { results: [] },
  genres: anime ? [{ id: 16, name: 'Animation' }] : [],
  original_language: anime ? 'ja' : 'en',
  origin_country: [anime ? 'JP' : 'GB'],
});

const requestSeries = async (tmdbId: number, anime: boolean) => {
  stub(TheMovieDb.prototype, 'getTvShow', series(tmdbId, anime));
  await MediaRequest.request(
    { mediaId: tmdbId, mediaType: MediaType.TV, seasons: [1], is4k: false },
    requester
  );
  // Sending is not awaited by the request; give it a moment.
  await new Promise((resolve) => setTimeout(resolve, 300));
};

beforeEach(async () => {
  added = [];
  mock.method(MediaRequest, 'sendNotification', async () => true);
  stub(SonarrAPI.prototype, 'getTags', []);
  stub(SonarrAPI.prototype, 'getEpisodes', []);
  stub(SonarrAPI.prototype, 'getProfiles', [
    { id: 1, name: 'Any' },
    { id: 4, name: 'Ultra' },
    { id: 6, name: 'Anime' },
    { id: 8, name: 'Anime Ultra' },
  ]);
  stub(SonarrAPI.prototype, 'addSeries', async (options: AddSeriesOptions) => {
    added.push(options);
    return { id: added.length, titleSlug: `series-${added.length}` };
  });

  getSettings().sonarr = [
    {
      id: 0,
      name: 'Sonarr',
      hostname: 'sonarr.invalid',
      port: 8989,
      apiKey: 'x',
      useSsl: false,
      activeProfileId: 1,
      activeProfileName: 'Any',
      activeDirectory: '/tv',
      activeAnimeProfileId: 6,
      activeAnimeDirectory: '/anime',
      activeLanguageProfileId: 1,
      is4k: false,
      isDefault: true,
      enableSeasonFolders: true,
      syncEnabled: false,
      preventSearch: true,
      tags: [],
      tagRequests: false,
      animeTags: [],
      seriesType: 'standard',
      animeSeriesType: 'anime',
    } as unknown as SonarrSettings,
  ];

  requester = await getRepository(User).save(
    new User({
      email: 'glasswing@example.invalid',
      permissions:
        Permission.REQUEST |
        Permission.REQUEST_ADVANCED |
        Permission.AUTO_APPROVE,
      avatar: '',
    })
  );
  requester.settings = await getRepository(UserSettings).save(
    new UserSettings({
      user: requester,
      defaultProfiles: [
        { service: 'sonarr', serverId: 0, profileId: 4 },
        { service: 'sonarr', serverId: 0, anime: true, profileId: 8 },
      ],
    })
  );
});

afterEach(() => {
  mock.restoreAll();
  getSettings().sonarr = [];
});

describe('a series sent without a quality profile', () => {
  it("goes with the requester's saved profile, the anime one for anime", async () => {
    await requestSeries(77001, false);
    await requestSeries(77002, true);

    assert.deepEqual(
      added.map((a) => [a.tvdbid, a.profileId, a.rootFolderPath]),
      [
        [78001, 4, '/tv'],
        [78002, 8, '/anime'],
      ]
    );
  });

  it('goes to the folder its profile maps to', async () => {
    getSettings().sonarr[0].profileFolders = [
      { profileId: 4, rootFolder: '/tv-ultra' },
    ];

    await requestSeries(77003, false);

    assert.deepEqual(
      added.map((a) => [a.profileId, a.rootFolderPath]),
      [[4, '/tv-ultra']]
    );
  });

  it("goes with the server's profile once the saved one is gone", async () => {
    stub(SonarrAPI.prototype, 'getProfiles', [{ id: 1, name: 'Any' }]);

    await requestSeries(77004, false);

    assert.deepEqual(
      added.map((a) => [a.profileId, a.rootFolderPath]),
      [[1, '/tv']]
    );
  });
});
