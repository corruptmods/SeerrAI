import { MediaStatus, MediaType } from '@server/constants/media';
import type { MediaServerKind } from '@server/constants/server';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaLibraryItem from '@server/entity/MediaLibraryItem';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import libraryAccess from '@server/lib/libraryAccess';
import type {
  AccessServer,
  ServerAccess,
} from '@server/lib/libraryAccess/types';
import type { ViewerReach } from '@server/lib/libraryVisibility';
import {
  applyReach,
  leaveOutUnreachable,
  limitToLibraries,
  openingOf,
  viewerReach,
} from '@server/lib/libraryVisibility';
import { Permission } from '@server/lib/permissions';
import { getSettings, jellyfinDefaults } from '@server/lib/settings';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Showing people only what their libraries hold: which copies of a title a
 * viewer opens, what they are shown, whose libraries are read and how often,
 * and the list query that leaves the rest out.
 */

setupTestDb();

const item = (
  server: MediaServerKind,
  libraryId: string,
  itemId: string,
  is4k = false
) => ({ server, libraryId, itemId, is4k });

const reachOf = (plex: string[]): ViewerReach => ({ plex: new Set(plex) });

/** plex.tv's ids, as shares list them, and each library's key on the server. */
const SECTIONS = new Map([
  ['9001', '1'],
  ['9002', '2'],
]);

let reads = 0;
let readFails = false;
let shared: Record<string, { all: boolean; libraries: string[] }> = {};

const fakeServer = (): AccessServer => ({
  canGiveAll: false,
  async read(only) {
    reads += 1;
    if (readFails) throw new Error('plex.tv did not answer');
    const access: ServerAccess = {
      libraries: [...SECTIONS.keys()].map((id) => ({
        id,
        title: id,
        type: 'movie',
      })),
      people: Object.entries(shared)
        .filter(([id]) => !only || id === only)
        .map(([id, set]) => ({ id, name: id, ref: id, ...set })),
      scanIds: SECTIONS,
    };
    return access;
  },
  async write(person, to) {
    shared[person.id] = to;
  },
});

beforeEach(() => {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.PLEX;
  settings.main.limitToLibraries = true;
  settings.plex = { ...settings.plex, machineId: 'machine-1', webAppUrl: '' };
  settings.jellyfin = { ...jellyfinDefaults(), connected: false };
  settings.emby = { ...jellyfinDefaults(), connected: false };
  settings.tautulli = { ...settings.tautulli, externalUrl: '' };
  cacheManager.getCache('libraryaccess').flush();
  reads = 0;
  readFails = false;
  shared = { '501': { all: false, libraries: ['9001'] } };
  mock.method(libraryAccess, 'server', async () => fakeServer());
});

afterEach(() => {
  mock.restoreAll();
  getSettings().main.limitToLibraries = false;
});

const viewer = (init: Partial<User> = {}) =>
  new User({ id: 40, permissions: Permission.REQUEST, plexId: 501, ...init });

describe('which copies of a title a viewer opens', () => {
  const title = { ratingKey: 'k-std', ratingKey4k: 'k-4k' } as Media;

  it('counts a title no library is recorded for as open', () => {
    assert.deepEqual(openingOf(title, [], reachOf(['1']), false, ['plex']), {
      open: true,
      links: {},
      openOn: ['plex'],
    });
  });

  it('shuts a copy held only in libraries the viewer cannot open, with no link', () => {
    const opening = openingOf(
      title,
      [item('plex', '2', 'k-std')],
      reachOf(['1']),
      false,
      ['plex']
    );
    assert.deepEqual(opening, {
      open: false,
      links: { plex: null },
      openOn: [],
    });
  });

  it('links the copy in a library the viewer opens when the title’s own item is elsewhere', () => {
    const opening = openingOf(
      title,
      [item('plex', '2', 'k-std'), item('plex', '1', 'k-family')],
      reachOf(['1']),
      false,
      ['plex']
    );
    assert.deepEqual(opening, {
      open: true,
      links: { plex: 'k-family' },
      openOn: ['plex'],
    });
  });

  it('keeps a copy open on a server whose libraries could not be read', () => {
    assert.equal(
      openingOf(title, [item('plex', '2', 'k-std')], {}, false, ['plex']).open,
      true
    );
  });

  it('keeps a title open when another server lets the viewer play it', () => {
    const both = { ...title, jellyfinMediaId: 'jf-1' } as Media;
    const opening = openingOf(
      both,
      [item('plex', '2', 'k-std'), item('jellyfin', 'kids', 'jf-1')],
      { plex: new Set(['1']), jellyfin: new Set(['kids']) },
      false,
      ['plex', 'jellyfin']
    );
    assert.deepEqual(opening, {
      open: true,
      links: { plex: null },
      openOn: ['jellyfin'],
    });
  });

  it('judges the 4K copy by its own libraries', () => {
    const items = [item('plex', '1', 'k-std'), item('plex', '4', 'k-4k', true)];
    assert.equal(
      openingOf(title, items, reachOf(['1']), false, ['plex']).open,
      true
    );
    assert.equal(
      openingOf(title, items, reachOf(['1']), true, ['plex']).open,
      false
    );
  });
});

describe('what a viewer is shown', () => {
  const series = () => {
    const media = new Media({
      tmdbId: 9101,
      mediaType: MediaType.TV,
      status: MediaStatus.PARTIALLY_AVAILABLE,
      status4k: MediaStatus.AVAILABLE,
      ratingKey: 'k-std',
      ratingKey4k: 'k-4k',
      seasons: [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.AVAILABLE,
        }),
        new Season({
          seasonNumber: 2,
          status: MediaStatus.PROCESSING,
          status4k: MediaStatus.UNKNOWN,
        }),
      ],
    });
    media.setPlayLinks();
    return media;
  };

  it('shows a copy the viewer cannot open as not available, without its play link', () => {
    const media = series();
    applyReach(
      media,
      [item('plex', '2', 'k-std'), item('plex', '1', 'k-4k', true)],
      reachOf(['1']),
      ['plex']
    );

    assert.equal(media.status, MediaStatus.UNKNOWN);
    assert.deepEqual(
      media.seasons.map((s) => s.status),
      [MediaStatus.UNKNOWN, MediaStatus.PROCESSING]
    );
    assert.equal(media.outsideLibraries, true);
    assert.equal(media.status4k, MediaStatus.AVAILABLE);
    assert.equal(media.outsideLibraries4k, undefined);
    assert.equal(media.playLinks?.length, 1);
    assert.equal(media.playLinks?.[0].url, undefined);
    assert.match(media.playLinks?.[0].url4k ?? '', /k-4k/);
    assert.equal(media.mediaUrl, undefined);
  });

  it('changes nothing for a viewer who opens every copy', () => {
    const media = series();
    const before = JSON.stringify(media);
    applyReach(
      media,
      [item('plex', '1', 'k-std'), item('plex', '1', 'k-4k', true)],
      reachOf(['1']),
      ['plex']
    );
    assert.equal(JSON.stringify(media), before);
  });
});

describe('the quality a viewer is shown', () => {
  const film = () => {
    const media = new Media({
      tmdbId: 9102,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.AVAILABLE,
      ratingKey: 'k-std',
      jellyfinMediaId: 'jf-1',
      quality: {
        plex: { standard: { resolutions: ['4K'], ranges: ['DV'] } },
        jellyfin: { standard: { resolutions: ['1080p'], ranges: [] } },
      },
    });
    media.setAvailableQuality();
    return media;
  };

  it('shows no quality for a copy the viewer cannot open', () => {
    const media = film();
    applyReach(
      media,
      [item('plex', '2', 'k-std'), item('jellyfin', 'adults', 'jf-1')],
      { plex: new Set(['1']), jellyfin: new Set(['kids']) },
      ['plex', 'jellyfin']
    );
    assert.equal(media.outsideLibraries, true);
    assert.equal(media.availableQuality, undefined);
  });

  it('shows only the quality on the servers the viewer opens it on', () => {
    const media = film();
    assert.deepEqual(media.availableQuality?.resolutions, ['4K', '1080p']);
    applyReach(
      media,
      [item('plex', '2', 'k-std'), item('jellyfin', 'kids', 'jf-1')],
      { plex: new Set(['1']), jellyfin: new Set(['kids']) },
      ['plex', 'jellyfin']
    );
    assert.deepEqual(media.availableQuality, {
      resolutions: ['1080p'],
      ranges: [],
    });
  });

  it('never sends the stored quality, which names the servers holding it', () => {
    const sent = JSON.parse(JSON.stringify(film()));
    assert.equal(sent.quality, undefined);
    assert.ok(sent.availableQuality);
  });
});

describe('whose libraries limit what they see', () => {
  it('limits nothing while the setting is off', async () => {
    getSettings().main.limitToLibraries = false;
    assert.equal(await viewerReach(viewer()), undefined);
    assert.equal(reads, 0);
  });

  it('limits nothing for people who manage requests or users', async () => {
    for (const permissions of [
      Permission.ADMIN,
      Permission.MANAGE_REQUESTS,
      Permission.MANAGE_USERS,
    ]) {
      assert.equal(await viewerReach(viewer({ permissions })), undefined);
    }
    assert.equal(reads, 0);
  });

  it('opens no library for an account linked to no media server, so unlinking shows no more', async () => {
    assert.deepEqual(await viewerReach(viewer({ plexId: null })), {
      plex: new Set(),
    });
    assert.equal(reads, 0);
  });

  it('reads someone’s libraries once, by the ids the scans use', async () => {
    const [first, second] = await Promise.all([
      viewerReach(viewer()),
      viewerReach(viewer()),
    ]);
    const third = await viewerReach(viewer());

    assert.deepEqual(first, { plex: new Set(['1']) });
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.equal(reads, 1);
  });

  it('limits nothing for someone given every library', async () => {
    shared['501'] = { all: true, libraries: ['9001', '9002'] };
    assert.equal(await viewerReach(viewer()), undefined);
  });

  it('gives no library to someone the server is not shared with', async () => {
    assert.deepEqual(await viewerReach(viewer({ plexId: 777 })), {
      plex: new Set(),
    });
  });

  it('gives no library on a connected server their account is not linked to', async () => {
    getSettings().jellyfin = {
      ...jellyfinDefaults(),
      connected: true,
      apiKey: 'key',
    };
    shared['501'] = { all: true, libraries: ['9001', '9002'] };
    assert.deepEqual(await viewerReach(viewer()), {
      plex: 'all',
      jellyfin: new Set(),
    });
  });

  it('shows everything, and logs it, when the server cannot be read', async () => {
    readFails = true;
    const warn = mock.method(logger, 'warn', () => logger);

    assert.equal(await viewerReach(viewer()), undefined);
    assert.equal(await viewerReach(viewer()), undefined);

    assert.equal(reads, 1);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(
      String(warn.mock.calls[0].arguments[0]),
      /Could not read someone's Plex libraries/
    );
  });

  it('reads them again after their libraries are changed here', async () => {
    await viewerReach(viewer());
    await libraryAccess.setPerson(
      'plex',
      '501',
      { all: false, libraries: ['9001', '9002'] },
      1
    );
    reads = 0;

    assert.deepEqual(await viewerReach(viewer()), {
      plex: new Set(['1', '2']),
    });
    assert.equal(reads, 1);
  });
});

describe('titles from the database', () => {
  const save = async (
    tmdbId: number,
    ratingKey: string | null,
    libraries: string[]
  ) => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
        ratingKey,
      })
    );
    for (const libraryId of libraries) {
      await getRepository(MediaLibraryItem).save(
        new MediaLibraryItem({
          mediaId: media.id,
          server: 'plex',
          libraryId,
          is4k: false,
          itemId: ratingKey ?? '',
        })
      );
    }
    return media;
  };

  beforeEach(async () => {
    // Glasswing in the family library, Static Garden only in the other, Lantern
    // Song not scanned since, Harbour Lights only in Radarr.
    await save(9201, 'k-9201', ['1']);
    await save(9202, 'k-9202', ['2']);
    await save(9203, 'k-9203', []);
    await save(9204, null, []);
  });

  const listed = async (reach: ViewerReach) =>
    (
      await leaveOutUnreachable(
        getRepository(Media)
          .createQueryBuilder('media')
          .where('media.tmdbId > 9200'),
        reach
      )
        .orderBy('media.tmdbId', 'ASC')
        .getMany()
    ).map((m) => m.tmdbId);

  it('leaves out only titles held in libraries the viewer cannot open', async () => {
    assert.deepEqual(await listed(reachOf(['1'])), [9201, 9203, 9204]);
  });

  it('leaves out every title the server holds for someone with no library there', async () => {
    assert.deepEqual(await listed(reachOf([])), [9203, 9204]);
  });

  it('leaves nothing out when the server’s libraries are unknown or all open', async () => {
    assert.deepEqual(await listed({}), [9201, 9202, 9203, 9204]);
    assert.deepEqual(await listed({ plex: 'all' }), [9201, 9202, 9203, 9204]);
  });

  it('shows loaded titles as the viewer’s libraries allow, in one read', async () => {
    const media = await getRepository(Media).find({
      where: [{ tmdbId: 9201 }, { tmdbId: 9202 }],
      order: { tmdbId: 'ASC' },
    });
    await limitToLibraries(media, viewer());

    assert.deepEqual(
      media.map((m) => [m.tmdbId, m.status, m.outsideLibraries ?? false]),
      [
        [9201, MediaStatus.AVAILABLE, false],
        [9202, MediaStatus.UNKNOWN, true],
      ]
    );
    assert.deepEqual(media[1].playLinks, []);
    assert.equal(reads, 1);
  });

  it('shows Discover and search titles as the viewer’s libraries allow', async () => {
    const media = await Media.getRelatedMedia(viewer(), [
      { tmdbId: 9201, mediaType: MediaType.MOVIE },
      { tmdbId: 9202, mediaType: MediaType.MOVIE },
    ]);
    assert.deepEqual(
      media
        .map((m) => [m.tmdbId, m.status])
        .sort(([a], [b]) => Number(a) - Number(b)),
      [
        [9201, MediaStatus.AVAILABLE],
        [9202, MediaStatus.UNKNOWN],
      ]
    );
  });
});
