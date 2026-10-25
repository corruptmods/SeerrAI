import ListenBrainzAPI from '@server/api/listenbrainz';
import {
  MusicBrainz,
  MusicBrainzBusyError,
  musicBrainz,
} from '@server/api/musicbrainz';
import type {
  MbArtist,
  MbReleaseGroup,
} from '@server/api/musicbrainz/interfaces';
import TheAudioDb from '@server/api/theaudiodb';
import {
  DiscoverSliderType,
  MUSIC_SLIDERS,
  defaultSliders,
} from '@server/constants/discover';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import Media from '@server/entity/Media';
import MusicMetadata from '@server/entity/MusicMetadata';
import { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import { musicImageProxy } from '@server/lib/imageproxy';
import type { LidarrSettings, MusicSettings } from '@server/lib/settings';
import { getSettings, musicDefaults } from '@server/lib/settings';
import discoverMusicRoutes from '@server/routes/discoverMusic';
import imageproxy, { useSessionForImages } from '@server/routes/imageproxy';
import musicRoutes from '@server/routes/music';
import { setupTestDb } from '@server/test/db';
import { MUSIC_FIXTURE_IDS, seedMusicFixtures } from '@server/utils/seedTestDb';
import type { AxiosInstance } from 'axios';
import cookieParser from 'cookie-parser';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import session from 'express-session';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { promises } from 'node:fs';
import type { Server } from 'node:http';
import http from 'node:http';
import path from 'node:path';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';
import sharp from 'sharp';

/*
 * Browsing music: the routes behind the real OpenAPI validator, with
 * MusicBrainz and ListenBrainz stubbed and a fake Lidarr that answers its
 * artist lookup.
 */

setupTestDb();

const IDS = MUSIC_FIXTURE_IDS;
const UNKNOWN_ARTIST = '5c72e1b9-4f3d-4a86-b917-d2a8f60c3e51';
const FANART = `https://assets.fanart.tv/fanart/music/${IDS.artist}/artistthumb/glasswing-5.jpg`;
const BACKDROP = `https://assets.fanart.tv/fanart/music/${IDS.artist}/artistbackground/glasswing-6.jpg`;

// The fake Lidarr: its artist lookup, and how often it was asked.
let lookups: string[] = [];
let lookupImages: { coverType: string; remoteUrl?: string }[] = [];
let lidarrUp = true;
const lidarr = http.createServer((req, res) => {
  if (!lidarrUp) {
    req.socket.destroy();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://x');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (url.pathname === '/api/v1/artist/lookup') {
    const term = url.searchParams.get('term') ?? '';
    lookups.push(term);
    const mbid = term.replace(/^lidarr:/, '');
    return res.end(
      JSON.stringify([
        {
          id: 0,
          artistName: 'Glasswing',
          foreignArtistId: mbid,
          images: lookupImages,
        },
      ])
    );
  }
  res.end('[]');
});
let lidarrPort = 0;

let app: Server;
let port = 0;
let actingAs: User | undefined;

// What the image proxy fetched from fanart.tv, and a session to ask with.
let fetchedPictures: string[] = [];
let pictureJpeg: Buffer;
const PICTURE_CACHE = path.join(__dirname, '../../config/cache/images/fanart');
const SECRET = 'test-secret';
const SIGNED_IN = `connect.sid=${encodeURIComponent(
  `s:signed-in.${createHmac('sha256', SECRET)
    .update('signed-in')
    .digest('base64')
    .replace(/=+$/, '')}`
)}`;

const lidarrServer = (): LidarrSettings =>
  ({
    id: 0,
    name: 'Lidarr',
    hostname: '127.0.0.1',
    port: lidarrPort,
    apiKey: 'k',
    useSsl: false,
    baseUrl: '',
    activeProfileId: 1,
    activeProfileName: 'Any',
    activeDirectory: '/music',
    activeMetadataProfileId: 1,
    activeMetadataProfileName: 'Standard',
    is4k: false,
    isDefault: true,
    tags: [],
    syncEnabled: false,
    preventSearch: false,
    tagRequests: false,
    overrideRule: [],
  }) as LidarrSettings;

const get = async (pathname: string) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${pathname}`, {
    redirect: 'manual',
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body: body as never, res };
};

const artist: MbArtist = {
  id: IDS.artist,
  name: 'Glasswing',
  'sort-name': 'Glasswing',
  type: 'Group',
  country: 'GB',
  area: { id: 'x', name: 'United Kingdom' },
  'life-span': { begin: '1985', end: null, ended: false },
  genres: [
    { name: 'rock', count: 3 },
    { name: 'alternative rock', count: 9 },
  ],
  relations: [
    {
      type: 'official homepage',
      url: { resource: 'https://www.glasswing.com/' },
    },
    { type: 'lyrics', url: { resource: 'https://lyrics.example/rh' } },
    { type: 'wikipedia', url: { resource: 'http://insecure.example/' } },
  ],
};

const album = (id: string, title: string, date: string): MbReleaseGroup => ({
  id,
  title,
  'primary-type': 'Album',
  'secondary-types': [],
  'first-release-date': date,
  'artist-credit': [
    {
      name: 'Glasswing',
      joinphrase: '',
      artist: { id: IDS.artist, name: 'Glasswing' },
    },
  ],
});

/*
 * A search for "Moonlurker", shaped like a real MusicBrainz answer observed
 * on 2026-10-19 (release-group search, limit 100): 338 results in all, the
 * first 98 of them exact titles that all score 100, in no useful order,
 * then weaker matches scoring 85. The first five, and the four albums
 * named below (their ids, release counts and places in the list), are as
 * MusicBrainz gave them; the other exact matches stand in for the many
 * small acts' albums and singles it listed (their ids are made up, their
 * release counts 1 or 2 as theirs were). The artists are made up.
 */
const MOONLURKER = {
  /** Marcus Delray's album: 98th, with 85 releases. */
  album: '9d2c7e15-3b84-3f0a-a6d1-2e8b5c4f9037',
  /** His single: about 82nd, with 7. */
  single: '6b18d4e2-7f05-3c91-b2e7-8a4c1d6f30b9',
  /** Octavius Ruiz's album: about 56th, with 7. */
  ruiz: '2e7d9a41-c63b-4f18-8d25-b1a0f9e3c742',
  /** Wrecker's album: about 69th, with 4. */
  wrecker: '8a1f6c37-d290-4b5e-9c73-000e4a2b6f18',
};
const MOONLURKER_TOTAL = 338;

const moonlurkerBand = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const madeUp = (n: number) =>
  `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;

/** Each act a made-up id of its own. */
const actIds = new Map<string, string>();
const credit = (name: string) => {
  if (!actIds.has(name)) {
    actIds.set(name, madeUp(5000 + actIds.size));
  }
  const id = actIds.get(name) as string;
  return [{ name, artist: { id, name } }];
};

const releaseGroup = (
  id: string,
  title: string,
  artistName: string,
  {
    score = 100,
    count = 1,
    type = 'Album',
    date,
  }: { score?: number; count?: number; type?: string; date?: string } = {}
): MbReleaseGroup => ({
  id,
  title,
  score,
  count,
  'primary-type': type,
  'secondary-types': [],
  'first-release-date': date,
  'artist-credit': credit(artistName),
});

/** One of the small acts' exact matches, numbered from 0. */
const smallMatch = (n: number, score = 100) =>
  releaseGroup(madeUp(n), 'Moonlurker', `Small act ${n}`, {
    score,
    count: 1 + (n % 2),
    type: ['Album', 'Single', 'EP'][n % 3],
  });

/** The first page of the real answer, as above. */
const moonlurkerAlbums = () => {
  const named: Record<number, MbReleaseGroup> = {
    1: releaseGroup(madeUp(9001), 'Moonlurker!', 'Warm Ashes'),
    2: releaseGroup(madeUp(9002), 'Moonlurker', 'Plummet'),
    3: releaseGroup(madeUp(9003), 'Moonlurker', 'Ronnie and the Fast Kites', {
      count: 2,
    }),
    4: releaseGroup(madeUp(9004), 'Moonlurker', 'Half Lemur', { count: 2 }),
    5: releaseGroup(madeUp(9005), 'Moonlurker', 'Rust Matilda'),
    56: releaseGroup(MOONLURKER.ruiz, 'Moonlurker', 'Octavius Ruiz', {
      count: 7,
    }),
    69: releaseGroup(MOONLURKER.wrecker, 'Moonlurker', 'Wrecker', { count: 4 }),
    82: releaseGroup(MOONLURKER.single, 'Moonlurker', 'Marcus Delray', {
      count: 7,
      type: 'Single',
    }),
    98: releaseGroup(MOONLURKER.album, 'Moonlurker', 'Marcus Delray', {
      count: 85,
      date: '1982-11-30',
    }),
    99: releaseGroup(madeUp(9099), 'Bad Moonlurker', 'Small act 99', {
      score: 85,
    }),
    100: releaseGroup(madeUp(9100), 'Gold Moonlurker', 'Small act 100', {
      score: 85,
    }),
  };
  const groups = Array.from(
    { length: 100 },
    (_, i) => named[i + 1] ?? smallMatch(i)
  );
  return { count: MOONLURKER_TOTAL, offset: 0, 'release-groups': groups };
};

/**
 * The same search had there been more exact matches: the first page all
 * ties without Marcus Delray's album, which is 20th on the second page,
 * and that page ends on weaker matches.
 */
const moonlurkerAlbumsAt = (offset: number) => {
  const groups =
    offset === 0
      ? Array.from({ length: 100 }, (_, i) => smallMatch(i))
      : Array.from({ length: 100 }, (_, i) =>
          i === 19
            ? releaseGroup(MOONLURKER.album, 'Moonlurker', 'Marcus Delray', {
                count: 85,
                date: '1982-11-30',
              })
            : smallMatch(offset + i, i < 60 ? 100 : 85)
        );
  return { count: MOONLURKER_TOTAL, offset, 'release-groups': groups };
};

const moonlurkerArtists = () => ({
  count: 25,
  offset: 0,
  artists: Array.from({ length: 25 }, (_, n) => ({
    id: moonlurkerBand(n),
    name: 'Moonlurker',
    score: 100,
    tags: n === 7 ? [{ name: 'hard rock', count: 2 }] : [],
  })),
});

/**
 * MusicBrainz on a mirror (so nothing waits a second between requests),
 * answering searches as given; what it was asked, by path and offset.
 */
const mirrorAnswering = (
  albumsAt: (offset: number) => unknown,
  artists: () => unknown = moonlurkerArtists
) => {
  getSettings().music = {
    ...musicDefaults(),
    musicbrainzUrl: 'http://mirror.local:5000',
  };
  cacheManager.getCache('musicbrainz').flush();
  const client = musicBrainz();
  const asked = mock.method(
    (client as unknown as { axios: AxiosInstance }).axios,
    'get',
    async (
      pathname: string,
      config: { params: Record<string, string | number> }
    ) => ({
      data:
        pathname === '/ws/2/artist'
          ? artists()
          : albumsAt(Number(config.params.offset)),
    })
  );
  const requests = () =>
    asked.mock.calls.map((call) => {
      const [pathname, config] = call.arguments as unknown as [
        string,
        { params: Record<string, string | number> },
      ];
      return `${pathname} ${config.params.limit}@${config.params.offset}`;
    });
  return { requests };
};

let admin: User;
let friend: User;

before(async () => {
  pictureJpeg = await sharp({
    create: { width: 1000, height: 1000, channels: 3, background: '#a53a6e' },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
  await promises.rm(PICTURE_CACHE, { recursive: true, force: true });
  Object.defineProperty(musicImageProxy('fanart'), 'axios', {
    configurable: true,
    value: {
      get: async (picture: string) => {
        fetchedPictures.push(picture);
        return {
          data: pictureJpeg,
          headers: { 'content-type': 'image/jpeg' },
        };
      },
    },
  });
  const store = new session.MemoryStore();
  await new Promise<void>((resolve) =>
    store.set('signed-in', { cookie: {}, userId: 2 } as never, () => resolve())
  );
  useSessionForImages({ store, secret: SECRET });
  await new Promise<void>((r) => lidarr.listen(0, '127.0.0.1', () => r()));
  lidarrPort = (lidarr.address() as { port: number }).port;
  const ex = express();
  ex.use(express.json());
  ex.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
      validateRequests: true,
      validateSecurity: false,
    })
  );
  ex.use((req, _res, next) => {
    (req as unknown as { user?: User }).user = actingAs;
    next();
  });
  ex.use('/api/v1/music', musicRoutes);
  ex.use('/api/v1/discover/music', discoverMusicRoutes);
  ex.use('/imageproxy', cookieParser(), imageproxy);
  ex.use(
    (
      err: { status?: number; message: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status ?? 500).json({ message: err.message })
  );
  app = await new Promise<Server>((resolve) => {
    const s = ex.listen(0, () => resolve(s));
  });
  port = (app.address() as { port: number }).port;
});

after(async () => {
  app?.close();
  lidarr.close();
  await promises.rm(PICTURE_CACHE, { recursive: true, force: true });
});

beforeEach(async () => {
  const settings = getSettings();
  settings.lidarr = [lidarrServer()];
  settings.music = musicDefaults();
  settings.main.disabledFeatures = [];
  settings.main.cacheImages = true;
  lookups = [];
  lookupImages = [
    { coverType: 'poster', remoteUrl: FANART },
    { coverType: 'fanart', remoteUrl: BACKDROP },
    { coverType: 'logo', remoteUrl: 'https://elsewhere.example/logo.png' },
  ];
  lidarrUp = true;
  cacheManager.getCache('lidarr').flush();
  admin = await getRepository(User).findOneByOrFail({ id: 1 });
  friend = await getRepository(User).findOneByOrFail({ id: 2 });
  actingAs = friend;
});

afterEach(() => {
  mock.restoreAll();
  getSettings().lidarr = [];
  getSettings().main.disabledFeatures = [];
});

describe('when music is there', () => {
  it('is not, before a default Lidarr is set up', async () => {
    getSettings().lidarr = [{ ...lidarrServer(), isDefault: false }];
    const { status, body } = await get('/music/search?query=glasswing');
    assert.equal(status, 404);
    assert.match((body as { message: string }).message, /not set up/);
  });

  it('is not, with music turned off for everyone or by the person', async () => {
    getSettings().main.disabledFeatures = ['music'];
    assert.equal((await get('/music/search?query=x')).status, 403);
    assert.equal((await get('/discover/music/popular-albums')).status, 403);

    getSettings().main.disabledFeatures = [];
    actingAs = Object.assign(new User(), friend, {
      settings: { disabledFeatures: ['music'] },
    });
    const { status, body } = await get(`/music/artist/${IDS.artist}`);
    assert.equal(status, 403);
    assert.equal((body as { message: string }).message, 'Music is turned off.');
  });

  it('refuses anything but a MusicBrainz id, without asking MusicBrainz', async () => {
    const getArtist = mock.method(MusicBrainz.prototype, 'getArtist');
    assert.equal((await get('/music/artist/not-an-id')).status, 400);
    assert.equal((await get('/music/album/123/tracks')).status, 400);
    assert.equal(getArtist.mock.callCount(), 0);
  });
});

describe('search', () => {
  it('finds artists and albums, with what Seerr already has', async () => {
    await seedMusicFixtures();
    const searchArtists = mock.method(
      MusicBrainz.prototype,
      'searchArtists',
      async () => ({
        count: 2,
        offset: 0,
        artists: [artist, { id: UNKNOWN_ARTIST, name: 'Someone Else' }],
      })
    );
    mock.method(MusicBrainz.prototype, 'searchReleaseGroups', async () => ({
      count: 1,
      offset: 0,
      'release-groups': [
        album(IDS.album, 'Sing to the Ferryman', '2003-06-09'),
      ],
    }));

    const { status, body } = await get('/music/search?query=glasswing');
    assert.equal(status, 200);
    const { artists, albums } = body as {
      artists: { id: string; status?: number; mediaType: string }[];
      albums: {
        id: string;
        status?: number;
        coverUrl: string;
        artistName: string;
      }[];
    };
    assert.deepEqual(
      artists.map((a) => [a.mediaType, a.id, a.status]),
      [
        ['artist', IDS.artist, MediaStatus.PARTIALLY_AVAILABLE],
        ['artist', UNKNOWN_ARTIST, undefined],
      ]
    );
    assert.equal(albums[0].status, MediaStatus.AVAILABLE);
    assert.equal(albums[0].artistName, 'Glasswing');
    assert.equal(
      albums[0].coverUrl,
      `https://coverartarchive.org/release-group/${IDS.album}/front-500`
    );
    assert.deepEqual(searchArtists.mock.calls[0].arguments.slice(0, 2), [
      'glasswing',
      { limit: 25, offset: 0 },
    ]);
  });

  it('shows 8 artists and 12 albums, whatever an older version saved', async () => {
    // Before Settings → Music was trimmed, how many a search showed, and
    // where music could be searched, were settings.
    getSettings().music.search = {
      inAll: false,
      musicPage: false,
      chip: false,
      artists: 3,
      albums: 20,
    } as MusicSettings['search'];
    const searchArtists = mock.method(
      MusicBrainz.prototype,
      'searchArtists',
      async () => ({ count: 0, offset: 0, artists: [] })
    );
    const searchAlbums = mock.method(
      MusicBrainz.prototype,
      'searchReleaseGroups',
      async () => ({ count: 0, offset: 0, 'release-groups': [] })
    );
    assert.equal((await get('/music/search?query=glasswing')).status, 200);
    // More are asked for than shown, so the best can be picked from them.
    assert.deepEqual(searchArtists.mock.calls[0].arguments[1], {
      limit: 25,
      offset: 0,
    });
    assert.deepEqual(searchAlbums.mock.calls[0].arguments[1], {
      limit: 100,
      offset: 0,
    });
  });

  it('shows the album you most likely mean first, from many more asked for', async () => {
    const { requests } = mirrorAnswering(moonlurkerAlbums);
    const { status, body } = await get('/music/search?query=Moonlurker');
    assert.equal(status, 200);
    const { artists, albums } = body as {
      artists: { id: string }[];
      albums: { id: string; artistName: string; primaryType: string }[];
    };
    assert.equal(albums.length, 12);
    // As ranked from the real answer: Marcus Delray's album (85
    // releases), Octavius Ruiz's and his single (7 each, the album
    // first), then Wrecker's (4).
    assert.deepEqual(
      albums.slice(0, 4).map((a) => [a.id, a.artistName, a.primaryType]),
      [
        [MOONLURKER.album, 'Marcus Delray', 'Album'],
        [MOONLURKER.ruiz, 'Octavius Ruiz', 'Album'],
        [MOONLURKER.single, 'Marcus Delray', 'Single'],
        [MOONLURKER.wrecker, 'Wrecker', 'Album'],
      ]
    );
    // The weaker matches come after every exact one.
    assert.ok(!albums.some((a) => [madeUp(9099), madeUp(9100)].includes(a.id)));
    // The first page ends on weaker matches: nothing more is asked for.
    assert.deepEqual(requests().sort(), [
      '/ws/2/artist 25@0',
      '/ws/2/release-group 100@0',
    ]);
    assert.equal(artists.length, 8);
    // The band with the most tags first, then MusicBrainz's order.
    assert.deepEqual(
      artists.slice(0, 3).map((a) => a.id),
      [moonlurkerBand(7), moonlurkerBand(0), moonlurkerBand(1)]
    );
  });

  it('looks on the next page while the results are still tied', async () => {
    const { requests } = mirrorAnswering(moonlurkerAlbumsAt);
    const { status, body } = await get('/music/search?query=Moonlurker');
    assert.equal(status, 200);
    assert.equal(
      (body as { albums: { id: string }[] }).albums[0].id,
      MOONLURKER.album
    );
    // The second page ends below the top score, so there is no third,
    // though MusicBrainz has more.
    assert.deepEqual(
      requests().filter((r) => r.startsWith('/ws/2/release-group')),
      ['/ws/2/release-group 100@0', '/ws/2/release-group 100@100']
    );
  });

  it('asks MusicBrainz once for a search made twice', async () => {
    const { requests } = mirrorAnswering(moonlurkerAlbumsAt);
    for (const query of ['Moonlurker', ' moonlurker ']) {
      const { status, body } = await get(
        `/music/search?query=${encodeURIComponent(query)}`
      );
      assert.equal(status, 200);
      assert.equal(
        (body as { albums: { id: string }[] }).albums[0].id,
        MOONLURKER.album
      );
    }
    assert.deepEqual(requests().sort(), [
      '/ws/2/artist 25@0',
      '/ws/2/release-group 100@0',
      '/ws/2/release-group 100@100',
    ]);
    cacheManager.getCache('musicbrainz').flush();
  });

  it('is there whether or not music is in All', async () => {
    mock.method(MusicBrainz.prototype, 'searchArtists', async () => ({
      count: 0,
      offset: 0,
      artists: [],
    }));
    mock.method(MusicBrainz.prototype, 'searchReleaseGroups', async () => ({
      count: 0,
      offset: 0,
      'release-groups': [],
    }));
    for (const inAll of [false, true]) {
      getSettings().music.search = { inAll };
      assert.equal(
        (await get('/music/search?query=glasswing')).status,
        200,
        String(inAll)
      );
    }
  });

  it('is still refused to someone with music off for themselves', async () => {
    getSettings().music.search = { inAll: true };
    actingAs = Object.assign(new User(), friend, {
      settings: { disabledFeatures: ['music'] },
    });
    assert.equal((await get('/music/search?query=glasswing')).status, 403);
  });

  it('says MusicBrainz is busy rather than keep someone waiting', async () => {
    mock.method(MusicBrainz.prototype, 'searchArtists', async () => {
      throw new MusicBrainzBusyError();
    });
    mock.method(MusicBrainz.prototype, 'searchReleaseGroups', async () => ({
      count: 0,
      offset: 0,
      'release-groups': [],
    }));
    const { status, body } = await get('/music/search?query=glasswing');
    assert.equal(status, 503);
    assert.match((body as { message: string }).message, /busy/);
  });
});

describe('an artist', () => {
  beforeEach(() => {
    mock.method(MusicBrainz.prototype, 'getArtist', async (id: string) => {
      if (id !== IDS.artist) {
        throw Object.assign(new Error('Not Found'), {
          response: { status: 404 },
        });
      }
      return artist;
    });
    mock.method(
      MusicBrainz.prototype,
      'getWikipediaExtract',
      async () => 'Glasswing are an English rock band.'
    );
  });

  it('is shown with their biography, links and genres', async () => {
    const { status, body } = await get(`/music/artist/${IDS.artist}`);
    assert.equal(status, 200);
    const details = body as Record<string, unknown>;
    assert.equal(details.name, 'Glasswing');
    assert.equal(details.biography, 'Glasswing are an English rock band.');
    assert.deepEqual(details.genres, ['alternative rock', 'rock']);
    // Only https links of the kinds people follow.
    assert.deepEqual(details.links, [
      { kind: 'official homepage', url: 'https://www.glasswing.com/' },
    ]);
    assert.equal(details.area, 'United Kingdom');
    assert.equal(details.mediaInfo, undefined);
  });

  it('shows their page without a biography MusicBrainz cannot give', async () => {
    mock.method(MusicBrainz.prototype, 'getWikipediaExtract', async () => {
      throw new MusicBrainzBusyError();
    });
    const { status, body } = await get(`/music/artist/${IDS.artist}`);
    assert.equal(status, 200);
    assert.equal((body as { biography: unknown }).biography, null);
  });

  it('shows their requests as the viewer may see them', async () => {
    await seedMusicFixtures();
    const asFriend = await get(`/music/artist/${IDS.artist}`);
    const media = (
      asFriend.body as {
        mediaInfo: {
          status: number;
          requests: {
            status: number;
            requestedBy: { email?: string; username: string };
          }[];
        };
        status: number;
      }
    ).mediaInfo;
    assert.equal(media.status, MediaStatus.PARTIALLY_AVAILABLE);
    assert.equal(media.requests.length, 5);
    for (const request of media.requests) {
      assert.equal(request.requestedBy.username, 'friend');
      assert.equal(request.requestedBy.email, undefined);
    }

    actingAs = admin;
    const asAdmin = await get(`/music/artist/${IDS.artist}`);
    const pending = (
      asAdmin.body as {
        mediaInfo: {
          requests: { status: number; requestedBy: { email?: string } }[];
        };
      }
    ).mediaInfo.requests.find((r) => r.status === MediaRequestStatus.PENDING);
    assert.equal(pending?.requestedBy.email, 'friend@seerr.dev');
  });

  it('is not found when MusicBrainz has no such artist', async () => {
    const { status } = await get(`/music/artist/${UNKNOWN_ARTIST}`);
    assert.equal(status, 404);
  });

  it('lists their albums a page at a time, with what Seerr has', async () => {
    await seedMusicFixtures();
    const browse = mock.method(
      MusicBrainz.prototype,
      'getArtistReleaseGroups',
      async () => ({
        'release-group-count': 150,
        'release-group-offset': 100,
        'release-groups': [
          album(IDS.album, 'Sing to the Ferryman', '2003-06-09'),
          album(IDS.otherAlbum, 'Static Garden', '1997-05-21'),
        ],
      })
    );
    const { status, body } = await get(
      `/music/artist/${IDS.artist}/albums?page=2`
    );
    assert.equal(status, 200);
    const page = body as {
      page: number;
      totalPages: number;
      totalResults: number;
      results: { id: string; status?: number }[];
    };
    assert.equal(page.page, 2);
    assert.equal(page.totalPages, 2);
    assert.equal(page.totalResults, 150);
    assert.deepEqual(
      page.results.map((r) => r.status),
      [MediaStatus.AVAILABLE, MediaStatus.PROCESSING]
    );
    assert.deepEqual(browse.mock.calls[0].arguments.slice(0, 2), [
      IDS.artist,
      { page: 1 },
    ]);
  });
});

describe('an artist’s picture', () => {
  it('comes from Lidarr’s lookup, through the image proxy, and is kept', async () => {
    const first = await get(`/music/artist/${IDS.artist}/image`);
    assert.equal(first.status, 302);
    assert.equal(
      first.res.headers.get('location'),
      `/imageproxy/fanart/fanart/music/${IDS.artist}/artistthumb/glasswing-5.jpg`
    );
    const backdrop = await get(
      `/music/artist/${IDS.artist}/image?kind=backdrop`
    );
    assert.equal(
      backdrop.res.headers.get('location'),
      `/imageproxy/fanart/fanart/music/${IDS.artist}/artistbackground/glasswing-6.jpg`
    );
    assert.deepEqual(lookups, [`lidarr:${IDS.artist}`], 'asked Lidarr once');
  });

  it('goes straight to its host when images are not cached', async () => {
    getSettings().main.cacheImages = false;
    const { res } = await get(`/music/artist/${IDS.artist}/image`);
    assert.equal(res.headers.get('location'), FANART);
  });

  it('comes from TheAudioDB when Lidarr has none and a key is set', async () => {
    lookupImages = [];
    getSettings().music = { ...musicDefaults(), theAudioDbApiKey: 'key' };
    mock.method(TheAudioDb.prototype, 'getArtistPictures', async () => ({
      thumb: 'https://www.theaudiodb.com/images/media/artist/thumb/abc.jpg',
      fanart: null,
    }));
    const { res } = await get(`/music/artist/${IDS.artist}/image`);
    assert.equal(
      res.headers.get('location'),
      '/imageproxy/tadb/images/media/artist/thumb/abc.jpg'
    );
  });

  it('falls back to the newest album cover MusicBrainz has listed, else none', async () => {
    lookupImages = [];
    assert.equal((await get(`/music/artist/${IDS.artist}/image`)).status, 404);

    await getRepository(MusicMetadata).save(
      new MusicMetadata({
        key: `rg-list:${IDS.artist}:all:0`,
        data: JSON.stringify({
          'release-group-count': 2,
          'release-group-offset': 0,
          'release-groups': [
            album(IDS.otherAlbum, 'Static Garden', '1997-05-21'),
            album(IDS.album, 'Sing to the Ferryman', '2003-06-09'),
          ],
        }),
        fetchedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      })
    );
    const { res } = await get(`/music/artist/${IDS.artist}/image`);
    assert.equal(
      res.headers.get('location'),
      `/imageproxy/caa/release-group/${IDS.album}/front-500`
    );
  });

  it('is asked for again next time when TheAudioDB does not answer', async () => {
    lookupImages = [];
    getSettings().music = { ...musicDefaults(), theAudioDbApiKey: 'key' };
    const down = mock.method(
      TheAudioDb.prototype,
      'getArtistPictures',
      async () => null
    );
    assert.equal((await get(`/music/artist/${IDS.artist}/image`)).status, 404);
    down.mock.restore();
    mock.method(TheAudioDb.prototype, 'getArtistPictures', async () => ({
      thumb: 'https://www.theaudiodb.com/images/media/artist/thumb/abc.jpg',
      fanart: null,
    }));
    const { res } = await get(`/music/artist/${IDS.artist}/image`);
    assert.equal(
      res.headers.get('location'),
      '/imageproxy/tadb/images/media/artist/thumb/abc.jpg'
    );
  });

  it('is asked for again next time when Lidarr does not answer', async () => {
    lidarrUp = false;
    assert.equal((await get(`/music/artist/${IDS.artist}/image`)).status, 404);
    lidarrUp = true;
    assert.equal((await get(`/music/artist/${IDS.artist}/image`)).status, 302);
  });
});

describe('an artist’s picture, from the image proxy', () => {
  const picture = (address: string, cookie: string | null = SIGNED_IN) =>
    fetch(`http://127.0.0.1:${port}/imageproxy/artist/${address}`, {
      headers: cookie ? { cookie } : {},
      redirect: 'manual',
    });

  it('is the one Lidarr has, served and kept as an image', async () => {
    fetchedPictures = [];
    const res = await picture(IDS.artist);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    // Which picture this is can change, so a browser keeps it for a day.
    assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
    assert.equal((await res.arrayBuffer()).byteLength, pictureJpeg.length);

    const backdrop = await picture(`${IDS.artist}/backdrop`);
    assert.equal(backdrop.status, 200);

    const avif = await picture(`${IDS.artist}?f=avif`);
    assert.equal(avif.headers.get('content-type'), 'image/avif');
    assert.equal(avif.headers.get('cache-control'), 'public, max-age=86400');
    assert.ok((await avif.arrayBuffer()).byteLength < pictureJpeg.length);

    // Asked again, the browser is told it already has it.
    const again = await fetch(
      `http://127.0.0.1:${port}/imageproxy/artist/${IDS.artist}`,
      {
        headers: {
          cookie: SIGNED_IN,
          'if-none-match': res.headers.get('etag') ?? '',
        },
      }
    );
    assert.equal(again.status, 304);
    assert.deepEqual(fetchedPictures, [
      `/fanart/music/${IDS.artist}/artistthumb/glasswing-5.jpg`,
      `/fanart/music/${IDS.artist}/artistbackground/glasswing-6.jpg`,
    ]);
    assert.deepEqual(lookups, [`lidarr:${IDS.artist}`], 'asked Lidarr once');
  });

  it('is not looked for for someone signed out, or while music is off', async () => {
    assert.equal((await picture(IDS.artist, null)).status, 403);
    getSettings().main.disabledFeatures = ['music'];
    assert.equal((await picture(IDS.artist)).status, 403);
    getSettings().main.disabledFeatures = [];
    getSettings().lidarr = [{ ...lidarrServer(), isDefault: false }];
    assert.equal((await picture(IDS.artist)).status, 404);
    assert.deepEqual(lookups, []);
  });

  it('is missing for an hour when the artist has none', async () => {
    lookupImages = [];
    const res = await picture(IDS.artist);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  });

  it('is only a MusicBrainz id, with or without the backdrop', async () => {
    for (const address of [
      'glasswing',
      `${IDS.artist}/photo`,
      `${IDS.artist}/backdrop/x`,
      `${IDS.artist}?w=480`,
    ]) {
      assert.equal((await picture(address)).status, 400, address);
    }
    assert.deepEqual(lookups, []);
  });
});

describe('an album', () => {
  it('is shown with its status and its artist’s record here', async () => {
    await seedMusicFixtures();
    mock.method(MusicBrainz.prototype, 'getReleaseGroup', async () => ({
      ...album(IDS.otherAlbum, 'Static Garden', '1997-05-21'),
      genres: [{ name: 'art rock', count: 4 }],
    }));
    const { status, body } = await get(`/music/album/${IDS.otherAlbum}`);
    assert.equal(status, 200);
    const details = body as {
      title: string;
      status: number;
      artistId: string;
      artists: { id: string; name: string }[];
      genres: string[];
      mediaInfo: { id: number; requests: unknown[] };
    };
    assert.equal(details.title, 'Static Garden');
    assert.equal(details.status, MediaStatus.PROCESSING);
    assert.equal(details.artistId, IDS.artist);
    assert.deepEqual(details.genres, ['art rock']);
    assert.equal(details.mediaInfo.requests.length, 5);
  });

  it('says where to play it, and where its artist is in Lidarr', async () => {
    await seedMusicFixtures();
    const settings = getSettings();
    const saved = {
      type: settings.main.mediaServerType,
      plex: { ...settings.plex },
      emby: { ...settings.emby },
      lidarr: settings.lidarr,
    };
    settings.main.mediaServerType = MediaServerType.PLEX;
    Object.assign(settings.plex, {
      connected: true,
      machineId: 'plex-machine',
      webAppUrl: '',
    });
    Object.assign(settings.emby, {
      connected: true,
      serverId: 'emby-server',
      externalHostname: 'https://emby.example.com',
    });
    settings.lidarr = [
      { ...lidarrServer(), externalUrl: 'https://lidarr.example.com' },
    ];
    try {
      mock.method(MusicBrainz.prototype, 'getReleaseGroup', async () =>
        album(IDS.album, 'Sing to the Ferryman', '2003-06-09')
      );
      const { status, body } = await get(`/music/album/${IDS.album}`);
      assert.equal(status, 200);
      const details = body as {
        playLinks: { server: string; url: string; iosUrl?: string }[];
        mediaInfo: { serviceUrl?: string };
      };
      assert.deepEqual(details.playLinks, [
        {
          server: 'plex',
          name: 'Plex',
          url: 'https://app.plex.tv/desktop#!/server/plex-machine/details?key=%2Flibrary%2Fmetadata%2F9002',
          iosUrl:
            'plex://preplay/?metadataKey=%2Flibrary%2Fmetadata%2F9002&server=plex-machine',
        },
        {
          server: 'emby',
          name: 'Emby',
          url: 'https://emby.example.com/web/index.html#!/item?id=emby-album&context=home&serverId=emby-server',
        },
      ]);
      assert.equal(
        details.mediaInfo.serviceUrl,
        `https://lidarr.example.com/artist/${IDS.artist}`
      );
    } finally {
      settings.main.mediaServerType = saved.type;
      Object.assign(settings.plex, saved.plex);
      Object.assign(settings.emby, saved.emby);
      settings.lidarr = saved.lidarr;
    }
  });

  it('is being added to the library while Lidarr has files no server lists', async () => {
    await seedMusicFixtures();
    mock.method(MusicBrainz.prototype, 'getReleaseGroup', async () =>
      album(IDS.otherAlbum, 'Static Garden', '1997-05-21')
    );
    const settings = getSettings();
    const saved = {
      type: settings.main.mediaServerType,
      plex: { ...settings.plex },
    };
    try {
      // No music library on anywhere: Lidarr's files decide, and three of
      // twelve tracks is not here yet.
      settings.plex.musicLibraries = [];
      let details = (await get(`/music/album/${IDS.otherAlbum}`)).body as {
        addingToLibrary?: boolean;
      };
      assert.equal(details.addingToLibrary, undefined);

      settings.main.mediaServerType = MediaServerType.PLEX;
      Object.assign(settings.plex, {
        connected: true,
        musicLibraries: [
          { id: '7', name: 'Music', enabled: true, type: 'artist' },
        ],
      });
      details = (await get(`/music/album/${IDS.otherAlbum}`)).body as {
        addingToLibrary?: boolean;
      };
      assert.equal(details.addingToLibrary, true);
    } finally {
      settings.main.mediaServerType = saved.type;
      Object.assign(settings.plex, saved.plex);
    }
  });

  it('lists its tracks, disc by disc', async () => {
    mock.method(MusicBrainz.prototype, 'getTracks', async () => [
      {
        position: 1,
        tracks: [
          {
            id: 't1',
            position: 1,
            number: '1',
            title: '3 + 3 = 7',
            length: 199000,
          },
          {
            id: 't2',
            position: 2,
            number: '2',
            title: 'Lie Down. Get Up.',
            recording: { id: 'r', title: 'x', length: 259000 },
          },
        ],
      },
    ]);
    const { status, body } = await get(`/music/album/${IDS.album}/tracks`);
    assert.equal(status, 200);
    assert.deepEqual((body as { tracks: unknown[] }).tracks, [
      { disc: 1, position: 1, number: '1', title: '3 + 3 = 7', length: 199000 },
      {
        disc: 1,
        position: 2,
        number: '2',
        title: 'Lie Down. Get Up.',
        length: 259000,
        recordingId: 'r',
      },
    ]);
  });
});

describe('Discover’s music rows', () => {
  it('lists new releases from ListenBrainz, newest first, twenty a page', async () => {
    const releases = Array.from({ length: 25 }, (_, i) => ({
      artist_credit_name: `Artist ${i}`,
      artist_mbids: [UNKNOWN_ARTIST],
      caa_release_mbid: i === 0 ? IDS.processingAlbum : null,
      release_date: `2026-10-${String(i + 1).padStart(2, '0')}`,
      release_group_mbid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      release_mbid: 'x',
      release_name: `Album ${i}`,
    }));
    // One without an id, which nothing could link to.
    releases.push({ ...releases[0], release_group_mbid: 'nope' });
    mock.method(ListenBrainzAPI.prototype, 'getFreshReleases', async () => ({
      payload: { releases },
    }));

    const first = await get('/discover/music/new-releases');
    const page = first.body as {
      totalResults: number;
      totalPages: number;
      results: { title: string; coverUrl: string }[];
    };
    assert.equal(page.totalResults, 25);
    assert.equal(page.totalPages, 2);
    assert.equal(page.results.length, 20);
    assert.equal(page.results[0].title, 'Album 24');
    const second = await get('/discover/music/new-releases?page=2');
    const last = (
      second.body as { results: { title: string; coverUrl: string }[] }
    ).results;
    assert.equal(last.length, 5);
    // ListenBrainz's own cover for the release it names.
    assert.equal(
      last[4].coverUrl,
      `https://coverartarchive.org/release/${IDS.processingAlbum}/front-500`
    );
  });

  it('lists popular albums and artists, with what Seerr has', async () => {
    await seedMusicFixtures();
    mock.method(ListenBrainzAPI.prototype, 'getTopReleaseGroups', async () => ({
      payload: {
        count: 2,
        offset: 0,
        range: 'week',
        last_updated: 0,
        release_groups: [
          {
            artist_mbids: [IDS.artist],
            artist_name: 'Glasswing',
            listen_count: 10,
            release_group_mbid: IDS.album,
            release_group_name: 'Sing to the Ferryman',
          },
          {
            artist_mbids: [],
            artist_name: 'Nobody',
            listen_count: 5,
            release_group_mbid: null,
            release_group_name: 'Unknown',
          },
        ],
      },
    }));
    mock.method(ListenBrainzAPI.prototype, 'getTopArtists', async () => ({
      payload: {
        count: 1,
        offset: 0,
        range: 'week',
        last_updated: 0,
        artists: [
          {
            artist_mbid: IDS.artist,
            artist_name: 'Glasswing',
            listen_count: 9,
          },
        ],
      },
    }));
    const albums = (await get('/discover/music/popular-albums')).body as {
      results: { id: string; status: number; artistId: string }[];
    };
    assert.deepEqual(
      albums.results.map((a) => [a.id, a.status, a.artistId]),
      [[IDS.album, MediaStatus.AVAILABLE, IDS.artist]]
    );
    const artists = (await get('/discover/music/popular-artists')).body as {
      results: { mediaType: string; id: string; status: number }[];
    };
    assert.deepEqual(artists.results, [
      {
        mediaType: 'artist',
        id: IDS.artist,
        name: 'Glasswing',
        status: MediaStatus.PARTIALLY_AVAILABLE,
      },
    ]);
  });

  it('are empty with ListenBrainz switched off, without asking it', async () => {
    getSettings().music = { ...musicDefaults(), listenBrainz: false };
    const fresh = mock.method(ListenBrainzAPI.prototype, 'getFreshReleases');
    const { status, body } = await get('/discover/music/new-releases');
    assert.equal(status, 200);
    assert.equal((body as { totalResults: number }).totalResults, 0);
    assert.equal(fresh.mock.callCount(), 0);
  });

  it('show what the media servers added most recently', async () => {
    const { artist } = await seedMusicFixtures();
    // The artist's name, as the music scans keep it.
    await getRepository(Media).update(artist.id, { foreignTitle: 'Glasswing' });
    const { status, body } = await get('/discover/music/recently-added');
    assert.equal(status, 200);
    // Only albums that are here and known to MusicBrainz.
    assert.deepEqual(
      (
        body as {
          results: {
            id: string;
            artistId: string;
            artistName: string;
            title: string;
          }[];
        }
      ).results.map((a) => [a.id, a.artistId, a.artistName, a.title]),
      [[IDS.album, IDS.artist, 'Glasswing', 'Sing to the Ferryman']]
    );
  });

  it('have numbers of their own and are added after the others, on', async () => {
    assert.deepEqual(MUSIC_SLIDERS, [25, 26, 27, 28]);
    assert.equal(DiscoverSliderType.MUSIC_RECENTLY_ADDED, 25);

    // A home page from before music.
    const repository = getRepository(DiscoverSlider);
    await repository.clear();
    let order = 0;
    for (const slider of defaultSliders) {
      if (!MUSIC_SLIDERS.includes(slider.type as DiscoverSliderType)) {
        await repository.save(
          new DiscoverSlider({ ...slider, order: order++ })
        );
      }
    }
    await DiscoverSlider.bootstrapSliders();
    const sliders = await repository.find({ order: { order: 'ASC' } });
    assert.deepEqual(
      sliders.slice(-5).map((s) => [s.type, s.enabled]),
      [
        [DiscoverSliderType.NETWORKS, true],
        ...MUSIC_SLIDERS.map((type) => [type, true]),
      ]
    );
    assert.equal(new Set(sliders.map((s) => s.order)).size, sliders.length);
  });
});
