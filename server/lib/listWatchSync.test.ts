import TautulliAPI from '@server/api/tautulli';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  MediaList,
  MediaListItem,
  MediaListMember,
  MediaListWatchSuggestion,
} from '@server/entity/MediaList';
import { User } from '@server/entity/User';
import { refreshWatchSuggestions } from '@server/lib/listWatchSync';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Watch sync suggests taking a title off a list once everyone on the list
 * has finished it, from Tautulli's history. Someone a list was shared with
 * is only asked about once they have accepted it.
 */

describe('watch sync', () => {
  setupTestDb();

  let owner: User;
  let member: User;
  let list: MediaList;
  let item: MediaListItem;
  /** Plex ids whose plays were asked for. */
  let asked: number[];
  /** Plex ids that have finished the film. */
  let watchedBy: number[];
  /** Runs while Tautulli is being asked, to change things meanwhile. */
  let duringCheck: () => Promise<void>;
  let kept: ReturnType<typeof getSettings>['tautulli'];

  before(() => {
    kept = getSettings().tautulli;
  });

  after(() => {
    getSettings().tautulli = kept;
  });

  const makeUser = async (name: string, plexId?: number) => {
    await getRepository(User).save(
      new User({
        email: `${name}@test.local`,
        plexUsername: name,
        plexId,
        permissions: Permission.REQUEST,
        avatar: '',
      })
    );

    return getRepository(User).findOneOrFail({
      where: { plexUsername: name },
    });
  };

  const suggested = () =>
    getRepository(MediaListWatchSuggestion).countBy({ listId: list.id });

  beforeEach(async () => {
    asked = [];
    watchedBy = [];
    duringCheck = async () => undefined;
    // Tautulli is Plex's watch history, read while Plex is connected.
    getSettings().main.mediaServerType = MediaServerType.PLEX;
    getSettings().tautulli = {
      hostname: 'tautulli.invalid',
      port: 8181,
      apiKey: 'x',
    };

    Object.defineProperty(TautulliAPI.prototype, 'getUserPlaysSince', {
      configurable: true,
      set() {},
      get() {
        return async (user: User) => {
          asked.push(user.plexId as number);
          await duringCheck();

          return watchedBy.includes(user.plexId as number)
            ? [
                {
                  media_type: 'movie',
                  rating_key: 'rk-1',
                  watched_status: 1,
                  percent_complete: 100,
                  user_id: user.plexId,
                  date: Math.floor(item.createdAt.getTime() / 1000) + 60,
                },
              ]
            : [];
        };
      },
    });

    owner = await makeUser('sync-owner', 101);
    member = await makeUser('sync-member', 102);
    list = await getRepository(MediaList).save(
      new MediaList({
        name: 'Movie Night',
        ownerId: owner.id,
        watchedSync: true,
      })
    );
    await getRepository(Media).save(
      new Media({
        tmdbId: 1,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        ratingKey: 'rk-1',
      })
    );
    item = await getRepository(MediaListItem).save(
      new MediaListItem({ listId: list.id, tmdbId: 1, mediaType: 'movie' })
    );
  });

  it('does not look at the history of someone who has not accepted', async () => {
    await getRepository(MediaListMember).save(
      new MediaListMember({ listId: list.id, userId: member.id })
    );
    watchedBy = [101];

    await refreshWatchSuggestions(owner);

    assert.deepEqual(asked, [101]);
  });

  it('waits for everyone who accepted', async () => {
    await getRepository(MediaListMember).save(
      new MediaListMember({
        listId: list.id,
        userId: member.id,
        acceptedAt: new Date(),
      })
    );
    watchedBy = [101];

    await refreshWatchSuggestions(owner);

    assert.deepEqual(asked.sort(), [101, 102]);
    assert.equal(await suggested(), 0);
  });

  it('suggests nothing while someone on the list cannot be checked', async () => {
    const noAccount = await makeUser('sync-local');
    await getRepository(MediaListMember).save(
      new MediaListMember({
        listId: list.id,
        userId: noAccount.id,
        acceptedAt: new Date(),
      })
    );
    watchedBy = [101];

    await refreshWatchSuggestions(owner);

    assert.equal(await suggested(), 0);
  });

  it('notes the check without touching anything else on the list', async () => {
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await getRepository(MediaList).update(list.id, { updatedAt: lastWeek });
    list = await getRepository(MediaList).findOneOrFail({
      where: { id: list.id },
    });

    // The owner renames the list while the check is running (kept at last
    // week's time here, so only the check could move it).
    duringCheck = async () => {
      await getRepository(MediaList).update(list.id, {
        name: 'Renamed',
        updatedAt: lastWeek,
      });
    };
    watchedBy = [101];

    await refreshWatchSuggestions(owner);

    const after = await getRepository(MediaList).findOneOrFail({
      where: { id: list.id },
    });
    assert.ok(after.lastWatchCheck, 'the check is noted');
    assert.equal(after.name, 'Renamed');
    assert.equal(
      after.updatedAt.getTime(),
      list.updatedAt.getTime(),
      'a check is not activity, so the list does not move up the page'
    );
    assert.equal(await suggested(), 1);
  });
});
