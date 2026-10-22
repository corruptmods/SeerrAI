import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/**
 * The live loop behind "HOLLOWAY - Phantom" being auto-approved every three
 * minutes.
 *
 * TVDB folded HOLLOWAY into its Phantom anthology entry, which TMDB assigns to
 * the anthology (336745), so the HOLLOWAY entry (226491) has no TVDB id of its
 * own. When a series request cannot resolve a TVDB id, the Sonarr dispatch
 * deleted both the media row and the request. Nothing survived, so watchlist
 * sync had no record of trying and tried again on every run — notifying each
 * time.
 */
describe('a series request whose TVDB id cannot be resolved', () => {
  setupTestDb();

  let user: User;

  const stub = (proto: object, name: string, value: unknown) =>
    Object.defineProperty(proto, name, {
      configurable: true,
      set() {},
      get() {
        return async () => value;
      },
    });

  const requestIt = () =>
    MediaRequest.request(
      {
        mediaId: 226491,
        mediaType: MediaType.TV,
        seasons: 'all',
        tvdbId: 497315,
        is4k: false,
      } as never,
      user,
      { isAutoRequest: true }
    );

  // The dispatch is fire-and-forget from the subscriber; give it a moment.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

  beforeEach(async () => {
    stub(TheMovieDb.prototype, 'getTvShow', {
      id: 226491,
      name: 'HOLLOWAY - Phantom: The Edgar Holloway Story',
      first_air_date: '2022-09-21',
      // What TMDB returns for this entry: no TVDB id of its own.
      external_ids: { tvdb_id: null },
      seasons: [{ season_number: 1, episode_count: 10 }],
      keywords: { results: [] },
      genres: [],
    });
    stub(SonarrAPI.prototype, 'getTags', []);
    stub(SonarrAPI.prototype, 'addSeries', { id: 1, seasons: [] });

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
        activeLanguageProfileId: 1,
        is4k: false,
        isDefault: true,
        enableSeasonFolders: true,
        syncEnabled: false,
        preventSearch: true,
        tags: [],
        tagRequests: false,
        animeTags: [],
      } as never,
    ];

    await getRepository(User).save(
      new User({
        email: 'unresolvable@test.local',
        plexUsername: 'unresolvable',
        permissions: Permission.ADMIN,
        avatar: '',
      })
    );
    user = await getRepository(User).findOneOrFail({
      where: { plexUsername: 'unresolvable' },
    });

    // The anthology, which legitimately holds TVDB 497315.
    await getRepository(Media).save(
      new Media({
        tmdbId: 336745,
        tvdbId: 497315,
        mediaType: MediaType.TV,
        status: MediaStatus.AVAILABLE,
      })
    );
  });

  it('keeps the request as a record, marked failed', async () => {
    await requestIt();
    await settle();

    const media = await getRepository(Media).findOne({
      where: { tmdbId: 226491, mediaType: MediaType.TV },
    });
    assert.ok(media, 'the media row must survive a failed dispatch');

    const requests = await getRepository(MediaRequest).find({
      relations: { media: true },
    });
    const forTitle = requests.filter((r) => r.media?.tmdbId === 226491);

    assert.equal(forTitle.length, 1, 'the request must survive as a record');
    assert.equal(
      forTitle[0].status,
      MediaRequestStatus.FAILED,
      'and show why it went nowhere'
    );
  });

  it('is not requested again on the next sync', async () => {
    await requestIt();
    await settle();

    // The next watchlist sync must see the earlier attempt and stop.
    const second = await requestIt().catch((e) => e);
    await settle();

    assert.ok(second instanceof Error, 'a repeat must be refused');

    const count = await getRepository(MediaRequest)
      .createQueryBuilder('request')
      .leftJoin('request.media', 'media')
      .where('media.tmdbId = :tmdbId', { tmdbId: 226491 })
      .getCount();

    assert.equal(count, 1, 'one record, not one per sync');
  });
});
