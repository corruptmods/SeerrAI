import JellyfinAPI from '@server/api/jellyfin';
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Episode from '@server/entity/Episode';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import { mediaServerCheck } from '@server/lib/health';
import { Permission } from '@server/lib/permissions';
import {
  compareMatch,
  jellyfinIds,
  jellyfinMatchItem,
} from '@server/lib/plexMatchCheck';
import { getSeriesProgress } from '@server/lib/seriesProgress';
import { getSettings } from '@server/lib/settings';
import { watchSource } from '@server/lib/watchHistory';
import { JellyfinWatchSource, playOf } from '@server/lib/watchHistory/jellyfin';
import { getWatchedBy } from '@server/lib/watchedBy';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Watch history from Jellyfin and Emby, against a stand-in that answers
 * /Items, /Users and /System/Info the way a real Jellyfin 12 and Emby 4.10
 * did when tried by hand: each person's items carry their own UserData
 * (Played, PlayCount, PlaybackPositionTicks, PlayedPercentage,
 * LastPlayedDate), filtered by IsPlayed or IsResumable and sorted by
 * DatePlayed.
 */

setupTestDb();

const KEY = 'test-api-key';
const iso = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString();

interface FakeItem {
  Id: string;
  Name: string;
  Type: 'Movie' | 'Episode' | 'Series';
  ProductionYear?: number;
  SeriesId?: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  Path?: string;
  ProviderIds?: Record<string, string>;
}

/** Items on the server, and what each account has done with them. */
let items: FakeItem[] = [];
let userData: Record<string, Record<string, Record<string, unknown>>> = {};
let accounts: { Id: string; Name: string; Policy: Record<string, unknown> }[] =
  [];
let asked: string[] = [];
let down = false;

const fake = http.createServer((req, res) => {
  const url = new URL(req.url ?? '', 'http://x');
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (down) return send(500, { error: 'down' });
  if (!String(req.headers.authorization ?? '').includes(`Token="${KEY}"`)) {
    return send(401, 'Access token is invalid or expired.');
  }
  asked.push(`${url.pathname}?${url.searchParams.toString()}`);
  if (url.pathname === '/System/Info') {
    return send(200, { Version: '12.2.0', ServerName: 'Test' });
  }
  if (url.pathname === '/Users') return send(200, accounts);
  const one = url.pathname.match(/^\/Users\/([^/]+)$/);
  if (one) {
    const account = accounts.find((a) => a.Id === one[1]);
    return account ? send(200, account) : send(404, 'Not found');
  }
  if (url.pathname !== '/Items') return send(404, 'Not found');
  const p = (name: string) => url.searchParams.get(name);
  const userId = p('UserId');
  const types = (p('IncludeItemTypes') ?? '').split(',').filter(Boolean);
  const ids = (p('Ids') ?? '').split(',').filter(Boolean);
  const filter = p('Filters');
  let found = items
    .filter((i) => !types.length || types.includes(i.Type))
    .filter((i) => !ids.length || ids.includes(i.Id))
    .filter((i) => !p('ParentId') || i.SeriesId === p('ParentId'))
    .map((i): FakeItem & { UserData?: Record<string, unknown> } => ({
      ...i,
      ...(userId
        ? {
            UserData: {
              PlaybackPositionTicks: 0,
              PlayCount: 0,
              IsFavorite: false,
              Played: false,
              ...userData[userId]?.[i.Id],
            },
          }
        : {}),
    }));
  if (filter === 'IsPlayed') found = found.filter((i) => i.UserData?.Played);
  if (filter === 'IsResumable') {
    found = found.filter(
      (i) =>
        !i.UserData?.Played &&
        Number(i.UserData?.PlaybackPositionTicks ?? 0) > 0
    );
  }
  if (p('SortBy') === 'DatePlayed') {
    found.sort((a, b) =>
      String(b.UserData?.LastPlayedDate ?? '').localeCompare(
        String(a.UserData?.LastPlayedDate ?? '')
      )
    );
  }
  const start = Number(p('StartIndex') ?? 0);
  const limit = Number(p('Limit') ?? found.length);
  send(200, {
    Items: found.slice(start, start + limit),
    TotalRecordCount: found.length,
  });
});

let port = 0;
before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  port = (fake.address() as { port: number }).port;
});
after(() => {
  fake.close();
});

const source = () =>
  new JellyfinWatchSource('jellyfin', KEY, `http://127.0.0.1:${port}`);

let alex: User;
let jordan: User;

beforeEach(async () => {
  down = false;
  asked = [];
  accounts = [
    { Id: 'a1', Name: 'Alex', Policy: { IsAdministrator: true } },
    { Id: 'j2', Name: 'Jordan', Policy: { IsAdministrator: false } },
    { Id: 'g3', Name: 'Guest', Policy: { IsDisabled: false } },
  ];
  items = [
    { Id: 'm1', Name: '1863 (2019)', Type: 'Movie', ProductionYear: 2019 },
    { Id: 's1', Name: 'The Herbalist Ledgers', Type: 'Series' },
    ...[1, 2, 3].map((n) => ({
      Id: `e${n}`,
      Name: `Episode ${n}`,
      Type: 'Episode' as const,
      SeriesId: 's1',
      SeriesName: 'The Herbalist Ledgers',
      ParentIndexNumber: 1,
      IndexNumber: n,
    })),
    // Seen on a real server mid-scan: an episode not placed in a series.
    { Id: 'x9', Name: 'Show - S02E24 - The Beginning', Type: 'Episode' },
  ];
  userData = {
    a1: {
      m1: { Played: true, PlayCount: 1, LastPlayedDate: iso(5) },
      e1: { Played: true, PlayCount: 1, LastPlayedDate: iso(3) },
      e2: { Played: true, PlayCount: 1, LastPlayedDate: iso(2) },
      e3: {
        Played: false,
        PlaybackPositionTicks: 6_000_000_000,
        // Past the end, as a real server reported for a short special.
        PlayedPercentage: 612.1,
        LastPlayedDate: iso(1),
      },
      x9: { Played: true, PlayCount: 1, LastPlayedDate: iso(0) },
    },
    j2: {
      m1: { Played: true, PlayCount: 1, LastPlayedDate: iso(4) },
      e1: { Played: true, PlayCount: 1, LastPlayedDate: iso(30) },
    },
    g3: {
      e1: { Played: false, PlaybackPositionTicks: 100, PlayedPercentage: 2 },
    },
  };
  const users = getRepository(User);
  alex = await users.save(
    new User({
      email: `jf-alex-${Date.now()}@test.local`,
      jellyfinUsername: 'Alex',
      jellyfinUserId: 'a1',
      permissions: Permission.ADMIN,
      avatar: '/a.png',
    })
  );
  jordan = await users.save(
    new User({
      email: `jf-jordan-${Date.now()}@test.local`,
      jellyfinUsername: 'Jordan',
      jellyfinUserId: 'j2',
      permissions: Permission.REQUEST,
      avatar: '/j.png',
    })
  );
});

const saveMedia = (fields: Partial<Media>) =>
  getRepository(Media).save(
    new Media({ status: MediaStatus.AVAILABLE, ...fields })
  );

describe('watch history from Jellyfin and Emby', () => {
  it('reads someone’s plays, finished and part-watched, newest first', async () => {
    const plays = await source().history(alex, 10);
    assert.deepEqual(
      plays.map((p) => [
        p.kind,
        p.titleId,
        p.title,
        p.season ?? null,
        p.episode ?? null,
        p.finished,
        p.percent,
      ]),
      [
        ['episode', 's1', 'The Herbalist Ledgers', 1, 3, false, 84],
        ['episode', 's1', 'The Herbalist Ledgers', 1, 2, true, 100],
        ['episode', 's1', 'The Herbalist Ledgers', 1, 1, true, 100],
        ['movie', 'm1', '1863 (2019)', null, null, true, 100],
      ],
      'the unplaced episode is left out, and 612% part-watched is not read as finished'
    );
    assert.equal(plays[3].year, 2019);
    assert.equal(plays[0].viewerId, 'a1');
    // Finished and part-watched are asked apart, as the server's filters
    // must all match when given together.
    assert.ok(asked.some((a) => a.includes('Filters=IsPlayed')));
    assert.ok(asked.some((a) => a.includes('Filters=IsResumable')));
  });

  it('has nothing for someone with no server account, without asking', async () => {
    const nobody = new User({ email: 'x@test.local' });
    assert.deepEqual(await source().history(nobody, 10), []);
    assert.deepEqual(asked, []);
  });

  it('says it could not ask, rather than "watched nothing"', async () => {
    down = true;
    await assert.rejects(source().history(alex, 10));
  });

  it('finds everyone who watched a title, on the server’s accounts', async () => {
    getSettings().main.mediaServerType = MediaServerType.JELLYFIN;
    getSettings().jellyfin = {
      ...getSettings().jellyfin,
      ip: '127.0.0.1',
      port,
      useSsl: false,
      urlBase: '',
      apiKey: KEY,
    };
    try {
      const film = await saveMedia({
        tmdbId: 641826,
        mediaType: MediaType.MOVIE,
        jellyfinMediaId: 'm1',
      });
      const people = await getWatchedBy(film);
      assert.deepEqual(
        people?.map((p) => [p.name, p.user?.id ?? null, p.count]),
        [
          ['Jordan', jordan.id, 1],
          ['Alex', alex.id, 1],
        ]
      );

      const series = await saveMedia({
        tmdbId: 331675,
        mediaType: MediaType.TV,
        jellyfinMediaId: 's1',
      });
      assert.deepEqual(
        (await getWatchedBy(series))?.map((p) => [p.name, p.count]),
        [
          ['Alex', 2],
          ['Jordan', 1],
        ],
        'episodes finished, not the part-watched one; the guest who only started one is not listed'
      );
    } finally {
      getSettings().main.mediaServerType = MediaServerType.NOT_CONFIGURED;
    }
  });

  it('reads plays of one title since a moment, for lists and progress', async () => {
    const series = await saveMedia({
      tmdbId: 331676,
      mediaType: MediaType.TV,
      jellyfinMediaId: 's1',
    });
    const since = await source().playsSince(
      alex,
      series,
      new Date(Date.now() - 2.5 * 86_400_000)
    );
    assert.deepEqual(
      since.map((p) => p.episode),
      [3, 2]
    );
  });

  it('counts a title marked watched by hand, which Emby keeps no date for', async () => {
    // As seen on a real Emby server: Played, but no LastPlayedDate.
    userData.j2.e2 = { Played: true, PlayCount: 1 };
    const series = await saveMedia({
      tmdbId: 331677,
      mediaType: MediaType.TV,
      jellyfinMediaId: 's1',
    });

    const plays = await source().history(jordan, 10);
    assert.deepEqual(
      plays.map((p) => [p.episode ?? null, p.at === 0]),
      [
        [null, false],
        [1, false],
        [2, true],
      ],
      'kept, after the dated plays'
    );

    // Since the beginning, it counts; since a moment, it cannot be shown to
    // be after it.
    assert.deepEqual(
      (await source().playsSince(jordan, series, new Date(0))).map(
        (p) => p.episode
      ),
      [1, 2]
    );
    assert.deepEqual(
      (
        await source().playsSince(
          jordan,
          series,
          new Date(Date.now() - 60 * 86_400_000)
        )
      ).map((p) => p.episode),
      [1]
    );

    // The same on an Emby server, which keeps its own settings, and its
    // own ids on people and titles.
    await getRepository(User).update(jordan.id, {
      jellyfinUserId: null,
      embyUserId: 'j2',
    });
    await getRepository(User).update(alex.id, {
      jellyfinUserId: null,
      embyUserId: 'a1',
    });
    series.jellyfinMediaId = null;
    series.embyMediaId = 's1';
    await getRepository(Media).update(series.id, {
      jellyfinMediaId: null,
      embyMediaId: 's1',
    });
    getSettings().main.mediaServerType = MediaServerType.EMBY;
    getSettings().emby = {
      ...getSettings().emby,
      ip: '127.0.0.1',
      port,
      useSsl: false,
      urlBase: '',
      apiKey: KEY,
    };
    try {
      const jordanRow = (await getWatchedBy(series))?.find(
        (p) => p.name === 'Jordan'
      );
      assert.equal(jordanRow?.count, 2);
      assert.ok(jordanRow?.lastWatched, 'the dated play still gives a date');

      delete userData.j2.e1;
      const onlyDateless = (await getWatchedBy(series))?.find(
        (p) => p.name === 'Jordan'
      );
      assert.equal(onlyDateless?.count, 1);
      assert.equal(onlyDateless?.lastWatched, null);
    } finally {
      getSettings().main.mediaServerType = MediaServerType.NOT_CONFIGURED;
    }
  });

  it('maps the server’s ids back to the library, regular and 4K', async () => {
    const film = await saveMedia({
      tmdbId: 641827,
      mediaType: MediaType.MOVIE,
      jellyfinMediaId: 'm-reg',
      jellyfinMediaId4k: 'm-4k',
    });
    const found = await source().mediaFor(['m-4k', 'nope']);
    assert.equal(found.get('m-4k')?.id, film.id);
    assert.equal(found.has('nope'), false);
    assert.deepEqual(source().titleIdsOf(film), ['m-reg', 'm-4k']);
    // Regular and 4K as one item: its plays are read, and counted, once.
    assert.deepEqual(
      source().titleIdsOf(
        new Media({ jellyfinMediaId: 'm-both', jellyfinMediaId4k: 'm-both' })
      ),
      ['m-both']
    );
    const users = await source().usersFor(['j2', 'unknown']);
    assert.equal(users.get('j2')?.id, jordan.id);
    assert.equal(users.size, 1);
  });

  it('works out where someone is in a series', async () => {
    // On an Emby server, people's and titles' ids are Emby's own.
    await getRepository(User).update(alex.id, {
      jellyfinUserId: null,
      embyUserId: 'a1',
    });
    alex.jellyfinUserId = null;
    alex.embyUserId = 'a1';
    getSettings().main.mediaServerType = MediaServerType.EMBY;
    getSettings().emby = {
      ...getSettings().emby,
      ip: '127.0.0.1',
      port,
      useSsl: false,
      urlBase: '',
      apiKey: KEY,
    };
    try {
      assert.equal(watchSource()?.label, 'Emby');
      const media = await saveMedia({
        tmdbId: 331677,
        mediaType: MediaType.TV,
        embyMediaId: 's1',
      });
      const season = await getRepository(Season).save(
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          media: Promise.resolve(media),
        })
      );
      for (const n of [1, 2, 3]) {
        await getRepository(Episode).save(
          new Episode({
            episodeNumber: n,
            status: MediaStatus.AVAILABLE,
            season: Promise.resolve(season),
          })
        );
      }
      const progress = await getSeriesProgress(alex, [331677]);
      assert.deepEqual(progress[331677], {
        state: 'up_next',
        next: { season: 1, episode: 3 },
        remaining: 1,
        furthest: { season: 1, episode: 2 },
      });
    } finally {
      getSettings().main.mediaServerType = MediaServerType.NOT_CONFIGURED;
    }
  });

  it('is used only when Jellyfin or Emby is set up with an API key', () => {
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.JELLYFIN;
    settings.jellyfin = { ...settings.jellyfin, ip: '127.0.0.1', apiKey: '' };
    try {
      assert.equal(watchSource(), undefined);
      settings.jellyfin = { ...settings.jellyfin, apiKey: KEY };
      assert.equal(watchSource()?.kind, 'jellyfin');
    } finally {
      settings.main.mediaServerType = MediaServerType.NOT_CONFIGURED;
    }
  });

  it('turns an item into a play only once someone has started it', () => {
    const viewer = { id: 'a1', name: 'Alex' };
    assert.equal(
      playOf({ Id: 'm', Name: 'M', Type: 'Movie' } as never, viewer),
      undefined
    );
    const play = playOf(
      {
        Id: 'm',
        Name: 'M',
        Type: 'Movie',
        UserData: { PlayCount: 2, Played: false },
      } as never,
      viewer
    );
    assert.equal(play?.at, 0, 'no date kept: sorts last, never in the future');
  });
});

describe('Jellyfin and Emby on the Health page', () => {
  it('says the version, or why it could not answer, in words', async () => {
    const ok = await mediaServerCheck(
      'jellyfin',
      new JellyfinAPI(`http://127.0.0.1:${port}`, KEY)
    );
    assert.equal(ok.status, 'ok');
    assert.match(ok.detail ?? '', /^Jellyfin 12\.2\.0 · \d+ ms$/);

    const wrongKey = await mediaServerCheck(
      'emby',
      new JellyfinAPI(`http://127.0.0.1:${port}`, 'wrong')
    );
    assert.equal(wrongKey.status, 'error');
    assert.equal(
      wrongKey.detail,
      'Emby did not accept the API key (Settings → Emby).'
    );

    const gone = await mediaServerCheck(
      'jellyfin',
      new JellyfinAPI('http://127.0.0.1:9', KEY)
    );
    assert.equal(gone.status, 'error');
    assert.match(gone.detail ?? '', /^Could not reach Jellyfin/);
  });
});

describe('Match Check on Jellyfin and Emby', () => {
  it('reads the ids the server matched, whatever their case', () => {
    assert.deepEqual(
      jellyfinIds({
        ProviderIds: { Imdb: 'tt27854871', Tmdb: '331675', Tvdb: '542683' },
      } as never),
      { imdbId: 'tt27854871', tmdbId: 331675, tvdbId: 542683 }
    );
    assert.deepEqual(
      jellyfinIds({ ProviderIds: { TMDB: 'x', imdb: 'nope' } } as never),
      {}
    );
  });

  it('finds a folder matched to another title, and says how to Identify it', () => {
    const byFolder = new Map([
      [
        'wrenna (2026)',
        [{ title: 'Wrenna', year: 2026, tmdbId: 1, server: 'Radarr' }],
      ],
    ]);
    const item = jellyfinMatchItem('movie', {
      Id: 'abc',
      Name: 'The Wrenna Diaries',
      Type: 'Movie',
      ProductionYear: 2013,
      Path: '/media/movies/Wrenna (2026)/Wrenna (2026).mkv',
      ProviderIds: { Tmdb: '2' },
    } as never);
    assert.deepEqual(item.folders, ['Wrenna (2026)']);
    const { checked, problem } = compareMatch(
      'movie',
      item,
      byFolder,
      'Jellyfin'
    );
    assert.equal(checked, true);
    assert.equal(problem?.mediaServer, 'Jellyfin');
    assert.equal(problem?.matched.key, 'abc');
    assert.equal(problem?.reason, 'other');
  });
});
