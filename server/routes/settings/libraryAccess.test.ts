import PlexTvAPI from '@server/api/plextv';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import LibraryAccessChange from '@server/entity/LibraryAccessChange';
import { User } from '@server/entity/User';
import { getSettings, jellyfinDefaults } from '@server/lib/settings';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import type { IncomingMessage, Server } from 'node:http';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

/*
 * Who sees which library: one person's libraries, and one library taken
 * from (or given to) everyone at once, with its preview and Undo, against
 * stand-ins that answer as Jellyfin, Emby and plex.tv do, behind the real
 * OpenAPI validator.
 */

setupTestDb();

const MOVIES = 'f137a2dd21bbc1b99aa5c0f6bf02a805';
const SHOWS = '5bcc1435c4854fb82d7eef41d6f8e709';
const MUSIC = '7e64e319657a9516ec78490da03edccb';
const GONE = '99999999999999999999999999999999';

const ADMIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ALL = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SOME = 'cccccccccccccccccccccccccccccccc';
const ONLY_MUSIC = 'dddddddddddddddddddddddddddddddd';
const NO_MUSIC = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

type Policy = Record<string, unknown> & {
  IsAdministrator?: boolean;
  EnableAllFolders: boolean;
  EnabledFolders: string[];
};

let accounts: { Id: string; Name: string; Policy: Policy }[] = [];
/** Accounts the stand-in refuses to change. */
let refuse = new Set<string>();
/** Emby lists libraries by Guid as well as a short Id. */
let emby = false;

const fresh = () => {
  refuse = new Set();
  accounts = [
    {
      Id: ADMIN,
      Name: 'Den Admin',
      Policy: {
        IsAdministrator: true,
        EnableAllFolders: true,
        EnabledFolders: [],
      },
    },
    {
      Id: ALL,
      Name: 'Wendle',
      Policy: {
        EnableAllFolders: true,
        EnabledFolders: [],
        RemoteClientBitrateLimit: 8,
      },
    },
    {
      Id: SOME,
      Name: 'Pip',
      Policy: {
        EnableAllFolders: false,
        // A library the server no longer has stays listed.
        EnabledFolders: [MOVIES, MUSIC, GONE],
      },
    },
    {
      Id: ONLY_MUSIC,
      Name: 'Marlo',
      Policy: { EnableAllFolders: false, EnabledFolders: [MUSIC] },
    },
    {
      Id: NO_MUSIC,
      Name: 'Tansy',
      Policy: { EnableAllFolders: false, EnabledFolders: [SHOWS] },
    },
  ];
};

const folders = () =>
  [
    { Id: MOVIES, Name: 'Movies', CollectionType: 'movies', short: '3' },
    { Id: SHOWS, Name: 'Shows', CollectionType: 'tvshows', short: '11' },
    { Id: MUSIC, Name: 'Music', CollectionType: 'music', short: '3454' },
  ].map(({ short, ...folder }) => ({
    ...folder,
    ...(emby ? { Id: short, Guid: folder.Id } : {}),
    Type: 'CollectionFolder',
  }));

const jellyfinStandIn = (req: IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  res.setHeader('Content-Type', 'application/json');
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (!String(req.headers.authorization).includes('Token="given"')) {
      res.statusCode = 401;
      return res.end('{}');
    }
    if (url.pathname === '/Library/MediaFolders') {
      return res.end(
        JSON.stringify({
          Items: [
            ...folders(),
            { Id: 'pl', Name: 'Playlists', Type: 'ManualPlaylistsFolder' },
          ],
        })
      );
    }
    if (url.pathname === '/Users') {
      return res.end(JSON.stringify(accounts));
    }
    const policy = url.pathname.match(/^\/Users\/(\w+)\/Policy$/);
    if (policy && req.method === 'POST') {
      const account = accounts.find((a) => a.Id === policy[1]);
      if (!account || refuse.has(account.Id)) {
        res.statusCode = 500;
        return res.end('{}');
      }
      account.Policy = JSON.parse(body);
      res.statusCode = 204;
      return res.end();
    }
    const one = accounts.find((a) => url.pathname === `/Users/${a.Id}`);
    if (one) {
      return res.end(JSON.stringify(one));
    }
    res.statusCode = 404;
    res.end('{}');
  });
};

let port = 0;
let jellyfinPort = 0;
const servers: Server[] = [];

before(async () => {
  const listen = (app: http.RequestListener) =>
    new Promise<number>((resolve) => {
      const server = http.createServer(app).listen(0, () => {
        resolve((server.address() as AddressInfo).port);
      });
      servers.push(server);
    });
  jellyfinPort = await listen(jellyfinStandIn);

  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    req.user = await getRepository(User).findOneOrFail({ where: { id: 1 } });
    next();
  });
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  app.use('/api/v1/settings', settingsRoutes);
  app.use(
    (
      err: { status?: number; message: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
  port = await listen(app);
});

after(() => servers.forEach((server) => server.close()));

/** plex.tv, as its sharing answers come back. */
interface PlexShare {
  user: { id: string; username: string };
  shareId: string;
  all: boolean;
  sections: string[];
}
let plexShares: PlexShare[] = [];
const plexPuts: { shareId: string; ids: string[] }[] = [];
const PLEX_SECTIONS = [
  { id: '101', key: '1', title: 'Films', type: 'movie' },
  { id: '102', key: '2', title: 'Series', type: 'show' },
  { id: '103', key: '3', title: 'Music', type: 'artist' },
];

const stubbed: { target: object; name: string }[] = [];
const stub = (target: object, name: string, fn: unknown) => {
  Object.defineProperty(target, name, {
    configurable: true,
    set() {},
    get() {
      return fn;
    },
  });
  stubbed.push({ target, name });
};

const usePlex = () => {
  plexShares = [
    {
      user: { id: '501', username: 'reefroy' },
      shareId: '9001',
      all: true,
      sections: ['101', '102', '103'],
    },
    {
      user: { id: '502', username: 'cobble' },
      shareId: '9002',
      all: false,
      sections: ['101', '103'],
    },
    {
      user: { id: '503', username: 'tunes-only' },
      shareId: '9003',
      all: false,
      sections: ['103'],
    },
  ];
  plexPuts.length = 0;
  const proto = PlexTvAPI.prototype;
  stub(proto, 'getSharingSections', async () =>
    PLEX_SECTIONS.map((s) => ({ ...s, shared: false }))
  );
  stub(proto, 'getUsers', async () => ({
    MediaContainer: {
      User: [
        ...plexShares.map((share) => ({
          $: { id: share.user.id, username: share.user.username, title: '' },
          Server: [
            {
              $: {
                id: share.shareId,
                machineIdentifier: 'den-plex-id',
                allLibraries: share.all ? '1' : '0',
              },
            },
          ],
        })),
        // A friend shared another server only.
        {
          $: { id: '600', username: 'elsewhere', title: '' },
          Server: [{ $: { id: '1', machineIdentifier: 'other-server' } }],
        },
      ],
    },
  }));
  stub(proto, 'getShareSections', async (_machine: string, id: string) => {
    const share = plexShares.find((s) => s.shareId === id)!;
    return PLEX_SECTIONS.map((s) => ({
      ...s,
      shared: share.sections.includes(s.id),
    }));
  });
  stub(
    proto,
    'setShareSections',
    async (_machine: string, id: string, ids: string[]) => {
      plexPuts.push({ shareId: id, ids });
      const share = plexShares.find((s) => s.shareId === id)!;
      share.all = false;
      share.sections = ids;
    }
  );
};

beforeEach(async () => {
  fresh();
  emby = false;
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.JELLYFIN;
  settings.jellyfin = {
    ...jellyfinDefaults(),
    ip: '127.0.0.1',
    port: jellyfinPort,
    apiKey: 'given',
    connected: true,
  };
  settings.emby = jellyfinDefaults();
  settings.plex = {
    ...settings.plex,
    machineId: 'den-plex-id',
    connected: false,
  };
  await getRepository(LibraryAccessChange).clear();
});

afterEach(() => {
  for (const { target, name } of stubbed.splice(0)) {
    delete (target as Record<string, unknown>)[name];
  }
});

const api = (route: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${port}/api/v1/settings${route}`, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  });
const post = (route: string, body?: unknown) =>
  api(route, { method: 'POST', body: JSON.stringify(body ?? {}) });
const put = (route: string, body?: unknown) =>
  api(route, { method: 'PUT', body: JSON.stringify(body ?? {}) });

const policyOf = (id: string) => accounts.find((a) => a.Id === id)!.Policy;

describe('library access on Jellyfin', () => {
  it('lists each library with who has it, administrators apart', async () => {
    const res = await api('/library-access/jellyfin');
    assert.equal(res.status, 200);
    const view = await res.json();
    assert.deepEqual(
      view.libraries.map(
        (l: { title: string; type: string; sharedWith: number }) => [
          l.title,
          l.type,
          l.sharedWith,
        ]
      ),
      [
        ['Movies', 'movie', 2],
        ['Shows', 'show', 2],
        ['Music', 'music', 3],
      ]
    );
    const admin = view.people.find((p: { id: string }) => p.id === ADMIN);
    assert.equal(admin.admin, true);
    assert.equal(
      view.people.find((p: { id: string }) => p.id === SOME).libraries.length,
      2
    );
  });

  it('previews taking a library from everyone without changing anything', async () => {
    const res = await post('/library-access/jellyfin/plan', {
      libraryId: MUSIC,
      action: 'remove',
    });
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.deepEqual(
      plan.change.map((p: { name: string }) => p.name),
      ['Wendle', 'Pip']
    );
    assert.equal(plan.fromAll, 1);
    assert.deepEqual(
      plan.emptied.map((p: { name: string }) => p.name),
      ['Marlo']
    );
    assert.equal(plan.unchanged, 1);
    assert.equal(plan.admins, 1);
    assert.equal(policyOf(ALL).EnableAllFolders, true);
  });

  it('takes it away, keeps the rest of each policy, and undoes it', async () => {
    const linked = await getRepository(User).save(
      new User({
        email: 'pip@seerr.dev',
        userType: UserType.JELLYFIN,
        jellyfinUserId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        permissions: 0,
        avatar: '',
      })
    );

    const res = await post('/library-access/jellyfin/apply', {
      libraryId: MUSIC,
      action: 'remove',
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.changed, 2);
    assert.deepEqual(result.failed, []);
    assert.equal(result.change.libraryTitle, 'Music');

    assert.deepEqual(policyOf(ALL), {
      EnableAllFolders: false,
      EnabledFolders: [MOVIES, SHOWS],
      RemoteClientBitrateLimit: 8,
    });
    assert.deepEqual(policyOf(SOME).EnabledFolders, [GONE, MOVIES]);
    // Left with nothing otherwise: left as they were.
    assert.deepEqual(policyOf(ONLY_MUSIC).EnabledFolders, [MUSIC]);
    assert.equal(policyOf(ADMIN).EnableAllFolders, true);

    // Their Seerr AI account is matched, whatever the id's dashes.
    const view = await (await api('/library-access/jellyfin')).json();
    assert.equal(
      view.people.find((p: { id: string }) => p.id === SOME).userId,
      linked.id
    );

    // Someone changed again since is left alone.
    policyOf(SOME).EnabledFolders = [SHOWS];
    const undone = await post(
      `/library-access/history/${result.change.id}/undo`
    );
    assert.equal(undone.status, 200);
    const back = await undone.json();
    assert.equal(back.changed, 1);
    assert.equal(back.skipped, 1);
    assert.equal(policyOf(ALL).EnableAllFolders, true);
    assert.deepEqual(policyOf(SOME).EnabledFolders, [SHOWS]);

    const again = await post(
      `/library-access/history/${result.change.id}/undo`
    );
    assert.equal(again.status, 409);

    const history = await (await api('/library-access/history')).json();
    assert.equal(history.length, 1);
    assert.equal(history[0].action, 'remove');
    assert.ok(history[0].undoneAt);
    await getRepository(User).delete(linked.id);
  });

  it('goes on past someone the server refuses', async () => {
    refuse.add(SOME);
    const result = await (
      await post('/library-access/jellyfin/apply', {
        libraryId: MUSIC,
        action: 'remove',
      })
    ).json();
    assert.equal(result.changed, 1);
    assert.deepEqual(result.failed, [
      { name: 'Pip', error: 'The server answered 500.' },
    ]);
    assert.equal(result.change.failed, 1);
  });

  it('gives a library to everyone who lacks it', async () => {
    const result = await (
      await post('/library-access/jellyfin/apply', {
        libraryId: SHOWS,
        action: 'add',
      })
    ).json();
    assert.equal(result.changed, 2);
    assert.deepEqual(policyOf(SOME).EnabledFolders, [
      GONE,
      MOVIES,
      SHOWS,
      MUSIC,
    ]);
    assert.deepEqual(policyOf(ONLY_MUSIC).EnabledFolders, [SHOWS, MUSIC]);
    // Nobody left to change.
    const none = await post('/library-access/jellyfin/apply', {
      libraryId: SHOWS,
      action: 'add',
    });
    assert.equal(none.status, 400);
  });

  it('sets one person’s libraries from their page', async () => {
    const user = await getRepository(User).save(
      new User({
        email: 'tansy@seerr.dev',
        userType: UserType.JELLYFIN,
        jellyfinUserId: NO_MUSIC,
        permissions: 0,
        avatar: '',
      })
    );
    const read = await (await api(`/library-access/user/${user.id}`)).json();
    assert.equal(read.length, 1);
    assert.equal(read[0].kind, 'jellyfin');
    assert.equal(read[0].canGiveAll, true);
    assert.deepEqual(read[0].person.libraries, [SHOWS]);

    const set = await put(`/library-access/user/${user.id}`, {
      kind: 'jellyfin',
      libraries: [MOVIES, SHOWS],
    });
    assert.equal(set.status, 200);
    assert.deepEqual(policyOf(NO_MUSIC).EnabledFolders, [MOVIES, SHOWS]);

    const everything = await put(`/library-access/user/${user.id}`, {
      kind: 'jellyfin',
      all: true,
      libraries: [],
    });
    assert.equal(everything.status, 200);
    assert.equal(policyOf(NO_MUSIC).EnableAllFolders, true);

    const empty = await put(`/library-access/user/${user.id}`, {
      kind: 'jellyfin',
      libraries: [],
    });
    assert.equal(empty.status, 400);

    const history = await (
      await api('/library-access/history?kind=jellyfin')
    ).json();
    assert.deepEqual(
      history.map((h: { action: string; personName: string }) => [
        h.action,
        h.personName,
      ]),
      [
        ['person', 'Tansy'],
        ['person', 'Tansy'],
      ]
    );
    await getRepository(User).delete(user.id);
  });

  it('refuses a server that is not connected', async () => {
    const res = await api('/library-access/emby');
    assert.equal(res.status, 404);
  });
});

describe('library access on Emby', () => {
  it('lists and changes libraries by Guid, whichever a policy holds', async () => {
    emby = true;
    getSettings().emby = { ...getSettings().jellyfin, connected: true };
    // An older policy listing a library by its short id.
    policyOf(NO_MUSIC).EnabledFolders = ['11'];
    const view = await (await api('/library-access/emby')).json();
    assert.deepEqual(
      view.people.find((p: { id: string }) => p.id === NO_MUSIC).libraries,
      [SHOWS]
    );
    await post('/library-access/emby/apply', {
      libraryId: MUSIC,
      action: 'add',
    });
    assert.deepEqual(policyOf(NO_MUSIC).EnabledFolders, [SHOWS, MUSIC]);
  });
});

describe('library access on Plex', () => {
  beforeEach(async () => {
    usePlex();
    getSettings().plex.connected = true;
    await getRepository(User).update(1, { plexToken: 'owner-token' });
  });

  it('reads each share and takes a library from everyone', async () => {
    const view = await (await api('/library-access/plex')).json();
    assert.deepEqual(
      view.libraries.map((l: { type: string; sharedWith: number }) => [
        l.type,
        l.sharedWith,
      ]),
      [
        ['movie', 2],
        ['show', 1],
        ['music', 3],
      ]
    );
    assert.equal(view.people.length, 3);

    const result = await (
      await post('/library-access/plex/apply', {
        libraryId: '103',
        action: 'remove',
      })
    ).json();
    assert.equal(result.changed, 2);
    assert.deepEqual(plexPuts, [
      { shareId: '9001', ids: ['101', '102'] },
      { shareId: '9002', ids: ['101'] },
    ]);

    // Undo gives back each library; Plex keeps no "new ones too" here.
    await post(`/library-access/history/${result.change.id}/undo`);
    assert.deepEqual(plexPuts.slice(2), [
      { shareId: '9001', ids: ['101', '102', '103'] },
      { shareId: '9002', ids: ['101', '103'] },
    ]);
  });

  it('sets a friend’s libraries, but not every library from here', async () => {
    const user = await getRepository(User).save(
      new User({
        email: 'cobble@seerr.dev',
        userType: UserType.PLEX,
        plexId: 502,
        permissions: 0,
        avatar: '',
      })
    );
    const read = await (await api(`/library-access/user/${user.id}`)).json();
    const plex = read.find((r: { kind: string }) => r.kind === 'plex');
    assert.equal(plex.canGiveAll, false);
    assert.deepEqual(plex.person.libraries, ['101', '103']);
    assert.equal(plex.person.userId, user.id);

    await put(`/library-access/user/${user.id}`, {
      kind: 'plex',
      libraries: ['102'],
    });
    assert.deepEqual(plexPuts, [{ shareId: '9002', ids: ['102'] }]);

    const all = await put(`/library-access/user/${user.id}`, {
      kind: 'plex',
      all: true,
      libraries: [],
    });
    assert.equal(all.status, 400);
    await getRepository(User).delete(user.id);
  });

  it('needs the owner’s Plex account', async () => {
    await getRepository(User).update(1, { plexToken: null });
    const res = await api('/library-access/plex');
    assert.equal(res.status, 400);
  });
});
