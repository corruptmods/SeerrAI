import { MediaStatus, MediaType } from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import {
  MEDIA_SERVER_KINDS,
  MediaServerType,
  typeOfKind,
} from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { watchSource } from '@server/lib/watchHistory';
import { CompositeWatchSource } from '@server/lib/watchHistory/composite';
import { JellyfinWatchSource } from '@server/lib/watchHistory/jellyfin';
import { TautulliWatchSource } from '@server/lib/watchHistory/tautulli';
import type { Play, WatchSource } from '@server/lib/watchHistory/types';
import { getWatchedBy } from '@server/lib/watchedBy';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Watch history with several media servers connected: each server's
 * history is read and put together, a person's accounts on two servers
 * count as one person, and one server failing still gives the others'.
 */

setupTestDb();

const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);

/** Connects the servers given, the first as the primary one. */
const connect = (...kinds: MediaServerKind[]) => {
  const settings = getSettings();
  settings.main.mediaServerType = typeOfKind(kinds[0]);
  for (const kind of MEDIA_SERVER_KINDS) {
    settings[kind].connected = kinds.includes(kind);
  }
};

beforeEach(() => {
  const settings = getSettings();
  settings.tautulli = {
    ...settings.tautulli,
    hostname: 'tautulli.invalid',
    port: 8181,
    apiKey: 'k',
  };
  settings.jellyfin = { ...settings.jellyfin, ip: 'jf.invalid', apiKey: 'jk' };
  settings.emby = { ...settings.emby, ip: 'emby.invalid', apiKey: 'ek' };
});

afterEach(() => {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.NOT_CONFIGURED;
  for (const kind of MEDIA_SERVER_KINDS) settings[kind].connected = false;
  mock.restoreAll();
});

const play = (fields: Partial<Play>): Play => ({
  at: now,
  kind: 'movie',
  itemId: 'i',
  titleId: 't',
  title: 'A film',
  finished: true,
  percent: 100,
  viewerId: 'v',
  viewerName: 'Someone',
  ...fields,
});

/** A stand-in server's history. */
const fakeSource = (
  label: string,
  {
    viewer,
    plays = [],
    fails = false,
    titleIds = ['t'],
  }: {
    viewer?: string;
    plays?: Play[];
    fails?: boolean;
    titleIds?: string[];
  }
): WatchSource & { asked: string[] } => {
  const asked: string[] = [];
  const answer = async (what: string) => {
    asked.push(what);
    if (fails) throw new Error(`${label} is down`);
    return plays;
  };
  return {
    kind: 'jellyfin',
    label,
    asked,
    viewerOf: () => viewer,
    titleIdsOf: () => titleIds,
    mediaFor: async (ids) =>
      new Map(ids.map((id) => [id, { id: Number(id.slice(1)) } as Media])),
    usersFor: async (ids) =>
      new Map(ids.map((id) => [id, { id: Number(id.slice(1)) } as User])),
    history: () => answer('history'),
    titleHistory: () => answer('titleHistory'),
    playsSince: () => answer('playsSince'),
  };
};

describe('which watch history is read', () => {
  it('is the one server’s own, unchanged, with one server', () => {
    connect('jellyfin');
    assert.ok(watchSource() instanceof JellyfinWatchSource);
    connect('plex');
    assert.ok(watchSource() instanceof TautulliWatchSource);
  });

  it('leaves Tautulli out while Plex is not connected', () => {
    connect('jellyfin');
    assert.equal(watchSource()?.kind, 'jellyfin');
  });

  it('reads every connected server’s together', () => {
    connect('jellyfin', 'plex');
    assert.equal(watchSource()?.kind, 'multi');
    assert.equal(watchSource()?.label, 'Jellyfin and Tautulli');

    connect('plex', 'jellyfin', 'emby');
    assert.equal(watchSource()?.label, 'Tautulli, Jellyfin and Emby');
  });

  it('counts only servers with history to read', () => {
    connect('plex', 'emby');
    getSettings().tautulli.hostname = '';
    assert.equal(watchSource()?.kind, 'emby');
  });
});

describe('watch history from several servers', () => {
  const user = { id: 7 } as User;

  it('puts each server’s plays together, newest first, told apart', async () => {
    const source = new CompositeWatchSource([
      {
        server: 'plex',
        source: fakeSource('Tautulli', {
          viewer: '1',
          plays: [play({ at: now - 3 * DAY, itemId: '10', titleId: '10' })],
        }),
      },
      {
        server: 'jellyfin',
        source: fakeSource('Jellyfin', {
          viewer: 'a1',
          plays: [
            play({ at: now - DAY, itemId: '10', titleId: '10' }),
            play({ at: now - 5 * DAY, itemId: 'm2', titleId: 'm2' }),
          ],
        }),
      },
    ]);

    assert.equal(source.viewerOf(user), 'plex:1,jellyfin:a1');
    const history = await source.history(user, 2);
    assert.deepEqual(
      history.map((p) => [p.itemId, p.titleId]),
      [
        ['jellyfin:10', 'jellyfin:10'],
        ['plex:10', 'plex:10'],
      ]
    );
    assert.deepEqual(source.titleIdsOf({} as Media), ['plex:t', 'jellyfin:t']);
  });

  it('finds titles and people on the server their id is from', async () => {
    const source = new CompositeWatchSource([
      { server: 'plex', source: fakeSource('Tautulli', {}) },
      { server: 'emby', source: fakeSource('Emby', {}) },
    ]);

    const media = await source.mediaFor(['plex:x5', 'emby:x6', 'untagged']);
    assert.deepEqual(
      [...media].map(([id, m]) => [id, m.id]),
      [
        ['plex:x5', 5],
        ['emby:x6', 6],
      ]
    );
    const users = await source.usersFor(['emby:u9', 'jellyfin:u1']);
    assert.deepEqual(
      [...users].map(([id, u]) => [id, u.id]),
      [['emby:u9', 9]]
    );
  });

  it('asks only the servers the person or title is on', async () => {
    const plex = fakeSource('Tautulli', { viewer: '1' });
    const jellyfin = fakeSource('Jellyfin', { viewer: undefined });
    const emby = fakeSource('Emby', { viewer: 'e1', titleIds: [] });
    const source = new CompositeWatchSource([
      { server: 'plex', source: plex },
      { server: 'jellyfin', source: jellyfin },
      { server: 'emby', source: emby },
    ]);

    await source.history(user, 10);
    await source.titleHistory({} as Media);
    await source.playsSince(user, {} as Media, new Date(0));

    assert.deepEqual(plex.asked, ['history', 'titleHistory', 'playsSince']);
    assert.deepEqual(jellyfin.asked, ['titleHistory']);
    assert.deepEqual(emby.asked, ['history']);
    assert.equal(
      new CompositeWatchSource([
        { server: 'jellyfin', source: jellyfin },
      ]).viewerOf(user),
      undefined
    );
  });

  it('gives the other servers’ plays when one fails, and says so once', async () => {
    const warned = mock.method(logger, 'warn', () => logger);
    const source = new CompositeWatchSource([
      {
        server: 'plex',
        source: fakeSource('Tautulli', { viewer: '1', fails: true }),
      },
      {
        server: 'jellyfin',
        source: fakeSource('Jellyfin', {
          viewer: 'a1',
          plays: [play({ itemId: 'm1' })],
        }),
      },
    ]);

    const plays = await source.history(user, 10);

    assert.deepEqual(
      plays.map((p) => p.itemId),
      ['jellyfin:m1']
    );
    assert.equal(warned.mock.callCount(), 1);
    assert.match(String(warned.mock.calls[0].arguments[0]), /Tautulli/);
  });

  it('says it could not ask when no server answers', async () => {
    mock.method(logger, 'warn', () => logger);
    const source = new CompositeWatchSource([
      {
        server: 'plex',
        source: fakeSource('Tautulli', { viewer: '1', fails: true }),
      },
      {
        server: 'emby',
        source: fakeSource('Emby', { viewer: 'e1', fails: true }),
      },
    ]);

    await assert.rejects(source.history(user, 10), /Tautulli is down/);
    await assert.rejects(source.titleHistory({} as Media), /Tautulli is down/);
  });
});

describe('who watched a title, on several servers', () => {
  it('counts a person’s accounts on two servers as one person', async () => {
    connect('plex', 'jellyfin');
    const users = getRepository(User);
    const alex = await users.save(
      new User({
        email: 'multi-alex@test.local',
        plexUsername: 'Alex',
        plexId: 101,
        jellyfinUserId: 'a1',
        permissions: Permission.ADMIN,
        avatar: '/a.png',
      })
    );
    const jordan = await users.save(
      new User({
        email: 'multi-jordan@test.local',
        plexUsername: 'Jordan',
        plexId: 102,
        permissions: Permission.REQUEST,
        avatar: '/j.png',
      })
    );
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 9100,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        ratingKey: '10',
        jellyfinMediaId: 'jf10',
      })
    );
    mock.method(TautulliWatchSource.prototype, 'titleHistory', async () => [
      play({ at: now - 3 * DAY, itemId: '10', viewerId: '101' }),
      play({ at: now - 2 * DAY, itemId: '10', viewerId: '102' }),
    ]);
    mock.method(JellyfinWatchSource.prototype, 'titleHistory', async () => [
      play({ at: now - DAY, itemId: 'jf10', viewerId: 'a1' }),
      play({
        at: now - 5 * DAY,
        itemId: 'jf10',
        viewerId: 'g3',
        viewerName: 'Guest',
      }),
    ]);

    const watchedBy = await getWatchedBy(media);

    assert.deepEqual(
      watchedBy?.map((w) => [w.user?.id ?? null, w.name, w.count]),
      [
        [alex.id, 'Alex', 2],
        [jordan.id, 'Jordan', 1],
        [null, 'Guest', 1],
      ]
    );
    assert.equal(
      watchedBy?.[0].lastWatched,
      new Date((now - DAY) * 1000).toISOString()
    );
  });

  it('still lists one server’s viewers when the other cannot be asked', async () => {
    connect('plex', 'jellyfin');
    mock.method(logger, 'warn', () => logger);
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 9101,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        ratingKey: '11',
        jellyfinMediaId: 'jf11',
      })
    );
    mock.method(TautulliWatchSource.prototype, 'titleHistory', async () => {
      throw new Error('Tautulli is down');
    });
    mock.method(JellyfinWatchSource.prototype, 'titleHistory', async () => [
      play({ itemId: 'jf11', viewerId: 'g3', viewerName: 'Guest' }),
    ]);

    const watchedBy = await getWatchedBy(media);

    assert.deepEqual(
      watchedBy?.map((w) => w.name),
      ['Guest']
    );
  });
});
