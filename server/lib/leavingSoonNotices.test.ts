import MaintainerrAPI from '@server/api/maintainerr';
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
import { UserSettings } from '@server/entity/UserSettings';
import { resetDeletingSoonForTests } from '@server/lib/deletingSoon';
import {
  resetLeavingSoon,
  tellLeavingSoon,
} from '@server/lib/leavingSoonNotices';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { Permission } from '@server/lib/permissions';
import type { MaintainerrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Whoever requested a film Maintainerr is about to delete is told, once for
 * each date it is set to go.
 */

setupTestDb();

const DAY_MS = 24 * 60 * 60_000;
const TMDB_ID = 4401;

let sent: { type: Notification; payload: NotificationPayload }[];
// TMDB's methods are set on each instance: the film's title, from here.
Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  configurable: true,
  set() {},
  get() {
    return async () => ({ title: 'Harbour Lights', poster_path: '/p.jpg' });
  },
});
/** When the film was added to the rule's collection. */
let addDate: Date;

const makeUser = async (name: string) => {
  const user = new User({
    email: `${name}@test.local`,
    plexUsername: name,
    permissions: Permission.REQUEST,
    avatar: '',
  });
  user.settings = new UserSettings({});
  await getRepository(User).save(user);
  return getRepository(User).findOneOrFail({ where: { plexUsername: name } });
};

beforeEach(async () => {
  sent = [];
  resetLeavingSoon();
  resetDeletingSoonForTests();
  getSettings().maintainerr = [
    {
      id: 0,
      name: 'Maintainerr',
      hostname: 'maintainerr.test',
      port: 6246,
      useSsl: false,
      urlBase: '',
      apiKey: '',
      showBadges: true,
      showDeletingSoon: true,
      allowKeep: true,
      keepDays: 0,
      soonDays: 7,
    } as MaintainerrSettings,
  ];
  // A 30-day rule, the film added 27 days ago: going in 3 days.
  addDate = new Date(Date.now() - 27 * DAY_MS);
  mock.method(MaintainerrAPI.prototype, 'getCollections', async () => [
    {
      id: 1,
      title: 'Unwatched films',
      isActive: true,
      arrAction: 0,
      deleteAfterDays: 30,
      type: 'movie',
    },
  ]);
  mock.method(MaintainerrAPI.prototype, 'getCollectionMedia', async () => [
    {
      id: 1,
      collectionId: 1,
      mediaServerId: 'plex-1',
      tmdbId: TMDB_ID,
      addDate: addDate.toISOString(),
    },
  ]);
  mock.method(
    notificationManager,
    'sendNotification',
    (type: Notification, payload: NotificationPayload) => {
      sent.push({ type, payload });
    }
  );

  const requester = await makeUser('leaving-requester');
  const media = await getRepository(Media).save(
    new Media({
      tmdbId: TMDB_ID,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.AVAILABLE,
    })
  );
  const request = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MOVIE,
      media,
      requestedBy: requester,
      status: MediaRequestStatus.PENDING,
      is4k: false,
    })
  );
  await getRepository(MediaRequest).update(request.id, {
    status: MediaRequestStatus.COMPLETED,
  });
  // Only what is told from here on.
  sent = [];
});

afterEach(() => {
  mock.restoreAll();
  getSettings().maintainerr = [];
});

describe('leaving soon', () => {
  it('tells the requester once, with when and how to keep it', async () => {
    await tellLeavingSoon();
    assert.equal(sent.length, 1);
    const [{ type, payload }] = sent;
    assert.equal(type, Notification.LEAVING_SOON);
    assert.equal(payload.subject, 'Harbour Lights is leaving soon');
    assert.equal(
      payload.message,
      'It’s set to be removed in 3 days. Open it and choose Keep to hold on to it.'
    );
    assert.equal(payload.notifyUser?.plexUsername, 'leaving-requester');
    assert.equal(payload.notifySystem, false);
    assert.equal(payload.notifyAdmin, false);
    assert.equal(payload.actionUrl, `/movie/${TMDB_ID}`);

    // Looked at again later: already told.
    resetLeavingSoon();
    await tellLeavingSoon();
    assert.equal(sent.length, 1);
  });

  it('tells again when it is kept and set to go on a later day', async () => {
    await tellLeavingSoon();
    addDate = new Date(Date.now() - 25 * DAY_MS);
    resetLeavingSoon();
    resetDeletingSoonForTests();
    await tellLeavingSoon();
    assert.equal(sent.length, 2);
    assert.match(sent[1].payload.message ?? '', /in 5 days/);
  });

  it('is not looked at again within half an hour', async () => {
    await tellLeavingSoon();
    addDate = new Date(Date.now() - 25 * DAY_MS);
    resetDeletingSoonForTests();
    await tellLeavingSoon();
    assert.equal(sent.length, 1);
  });
});
