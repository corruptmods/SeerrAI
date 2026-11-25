import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import libraryAccess, { LibraryAccessError } from '@server/lib/libraryAccess';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { createFakeSilo } from '@server/test/fakeSilo';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Library sharing on Silo: who sees which library, from each account's own
 * list or its access group's, changed with the optional admin:users scope.
 */

setupTestDb();

const silo = createFakeSilo();

before(() => silo.start());
after(() => silo.stop());

const FILMS = '1';
const SERIES = '2';
const BOOKS = '4';

beforeEach(async () => {
  silo.reset();
  silo.libraries = [
    { id: FILMS, name: 'Films', type: 'movies' },
    { id: SERIES, name: 'Series', type: 'series' },
    { id: '3', name: 'Everything', type: 'mixed' },
    { id: BOOKS, name: 'Audiobooks', type: 'audiobooks' },
  ];
  // A library /user/libraries doesn't list (hidden), which an account holds.
  silo.allLibraryIds = [FILMS, SERIES, '3', BOOKS, '9'];
  silo.accounts = [
    { id: '1', username: 'harbour', password: 'x', role: 'admin' },
    {
      id: '2',
      username: 'lantern',
      password: 'x',
      role: 'user',
      libraryIds: [FILMS, '9'],
    },
    { id: '3', username: 'garden', password: 'x', role: 'user' },
    {
      id: '4',
      username: 'glasswing',
      password: 'x',
      role: 'user',
      groupLibraryIds: [SERIES],
    },
  ];
  silo.keys.set('sa_test', {
    scopes: ['admin:monitor:read', 'libraries:read', 'admin:users'],
    admin: true,
  });
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.SILO;
  settings.plex.connected = false;
  settings.jellyfin.connected = false;
  settings.emby.connected = false;
  settings.silo = silo.settings({ optionalScopes: ['admin:users'] });
  await getRepository(User).update(2, { siloUserId: '2' });
});

const person = async (id: string) =>
  (await libraryAccess.view('silo')).people.find((p) => p.id === id);

describe('library sharing on Silo', () => {
  it('reads each account’s libraries, its group’s, or every one', async () => {
    const view = await libraryAccess.view('silo');
    assert.deepEqual(
      view.libraries.map((l) => [l.title, l.type]),
      [
        ['Films', 'movie'],
        ['Series', 'show'],
        ['Everything', 'other'],
        ['Audiobooks', 'other'],
      ]
    );
    const lantern = view.people.find((p) => p.id === '2');
    assert.deepEqual(lantern?.libraries, [FILMS]);
    assert.equal(lantern?.all, false);
    assert.equal(lantern?.userId, 2, 'linked to its Seerr AI user');
    assert.equal((await person('3'))?.all, true);
    assert.deepEqual((await person('4'))?.libraries, [SERIES]);
    assert.equal((await person('1'))?.admin, true);
  });

  it('shares a library with everyone, never changing an administrator, and undoes it', async () => {
    const result = await libraryAccess.apply('silo', '3', 'add', 1);
    assert.equal(result.changed, 2, 'lantern and glasswing');
    // Lantern keeps the library Seerr AI can't see.
    assert.deepEqual(silo.accounts[1].libraryIds, ['9', FILMS, '3']);
    // Glasswing had its group's list, and now one of its own.
    assert.deepEqual(silo.accounts[3].libraryIds, [SERIES, '3']);
    assert.equal(silo.accounts[0].libraryIds, undefined);
    const puts = silo.calls.filter((call) => call.method === 'PUT');
    assert.ok(puts.every((call) => call.path.startsWith('/admin/users/')));

    assert.ok(result.change);
    const undone = await libraryAccess.undo(result.change.id);
    assert.equal(undone.changed, 2);
    assert.deepEqual(silo.accounts[1].libraryIds, ['9', FILMS]);
  });

  it('gives someone every library by following their group, or listing them all', async () => {
    await libraryAccess.setPerson('silo', '2', { all: true, libraries: [] }, 1);
    assert.equal(silo.accounts[1].libraryIds, undefined, 'follows its group');
    assert.equal((await person('2'))?.all, true);

    // Glasswing's group allows only the series.
    await libraryAccess.setPerson('silo', '4', { all: true, libraries: [] }, 1);
    assert.deepEqual(
      [...(silo.accounts[3].libraryIds ?? [])].sort(),
      [FILMS, SERIES, '3', BOOKS].sort()
    );
    // It reads back as every library, so saving it again changes nothing.
    assert.equal((await person('4'))?.all, true);
    const puts = silo.calls.filter((call) => call.method === 'PUT').length;
    const again = await libraryAccess.setPerson(
      'silo',
      '4',
      { all: true, libraries: [] },
      1
    );
    assert.equal(
      silo.calls.filter((call) => call.method === 'PUT').length,
      puts,
      JSON.stringify(again)
    );
  });

  it('reads a list of every library as every library only for an account its group limits', async () => {
    // Outside a group, a full list isn't "every library": saving that
    // gives them new libraries too.
    silo.accounts[2].libraryIds = [FILMS, SERIES, '3', BOOKS];
    assert.equal((await person('3'))?.all, false);
    silo.accounts[3].libraryIds = [FILMS, SERIES];
    assert.equal((await person('4'))?.all, false);
  });

  it('is hidden, saying why, without the admin:users scope', async () => {
    getSettings().silo.optionalScopes = [];
    await assert.rejects(
      () => libraryAccess.view('silo'),
      (e: unknown) =>
        e instanceof LibraryAccessError && /admin:users/.test(e.message)
    );
    const forUser = await libraryAccess.forUser(2);
    const entry = forUser.find((access) => access.kind === 'silo');
    assert.match(entry?.error ?? '', /admin:users/);
  });

  it('names the scope when Silo refuses the change', async () => {
    // The key lost the scope since Seerr AI connected.
    silo.keys.set('sa_test', {
      scopes: ['admin:monitor:read', 'libraries:read'],
      admin: true,
    });
    const result = await libraryAccess.setPerson(
      'silo',
      '2',
      { all: false, libraries: [FILMS, SERIES] },
      1
    );
    assert.equal(result.changed, 0);
    assert.match(result.failed[0].error, /admin:users/);
    assert.deepEqual(silo.accounts[1].libraryIds, [FILMS, '9']);
  });
});
