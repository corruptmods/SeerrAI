import type { LidarrAlbum, LidarrArtist } from '@server/api/servarr/lidarr';
import type { LidarrSettings } from '@server/lib/settings';
import http from 'node:http';

/*
 * A Lidarr on localhost for tests: it answers the calls Seerr makes when
 * sending a music request, from what a test puts in it, and writes down
 * every call in order so a test can say what was asked and what never was.
 */

export interface LidarrCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface FakeLidarr {
  /** Every call, in order. */
  calls: LidarrCall[];
  /** Artists Lidarr has. */
  artists: LidarrArtist[];
  /** Albums Lidarr has, of those artists. */
  albums: LidarrAlbum[];
  /** What Lidarr's metadata service can look up, by MusicBrainz id. */
  lookupArtists: Map<string, LidarrArtist>;
  lookupAlbums: Map<string, LidarrAlbum>;
  tags: { id: number; label: string }[];
  /** Answers every call with a server error while set. */
  down: boolean;
  settings: (overrides?: Partial<LidarrSettings>) => LidarrSettings;
  reset: () => void;
  start: () => Promise<void>;
  stop: () => void;
  /**
   * Resolves once a call matching it has been made (or after a while), and
   * what Seerr does after it has had a moment.
   */
  waitFor: (match: (call: LidarrCall) => boolean) => Promise<void>;
}

export const createFakeLidarr = (): FakeLidarr => {
  let port = 0;
  let nextId = 100;

  const fake: FakeLidarr = {
    calls: [],
    artists: [],
    albums: [],
    lookupArtists: new Map(),
    lookupAlbums: new Map(),
    tags: [],
    down: false,
    settings: (overrides = {}) =>
      ({
        id: 0,
        name: 'Lidarr',
        hostname: '127.0.0.1',
        port,
        apiKey: 'k',
        useSsl: false,
        baseUrl: '',
        activeProfileId: 1,
        activeProfileName: 'Any',
        activeDirectory: '/music',
        activeMetadataProfileId: 2,
        activeMetadataProfileName: 'Standard',
        is4k: false,
        isDefault: true,
        tags: [],
        syncEnabled: false,
        preventSearch: false,
        tagRequests: false,
        overrideRule: [],
        ...overrides,
      }) as LidarrSettings,
    reset: () => {
      fake.calls = [];
      fake.artists = [];
      fake.albums = [];
      fake.lookupArtists = new Map();
      fake.lookupAlbums = new Map();
      fake.tags = [];
      fake.down = false;
    },
    start: () =>
      new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', () => {
          port = (server.address() as { port: number }).port;
          resolve();
        })
      ),
    stop: () => {
      server.close();
    },
    waitFor: async (match) => {
      for (let i = 0; i < 100; i++) {
        if (fake.calls.some(match)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // What Seerr writes down after the call, before the test looks.
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
  };

  const answer = (call: LidarrCall): [number, unknown] => {
    const { method, path, query, body } = call;
    const term = (query.term ?? '').replace(/^lidarr:/, '');

    if (method === 'GET' && path === '/api/v1/artist') {
      return [
        200,
        fake.artists.filter(
          (artist) => !query.mbId || artist.foreignArtistId === query.mbId
        ),
      ];
    }
    if (method === 'GET' && path === '/api/v1/artist/lookup') {
      const found = fake.lookupArtists.get(term);
      return [200, found ? [found] : []];
    }
    if (method === 'GET' && path === '/api/v1/album/lookup') {
      const found = fake.lookupAlbums.get(term);
      return [200, found ? [found] : []];
    }
    if (method === 'GET' && path === '/api/v1/album') {
      return [
        200,
        fake.albums.filter(
          (album) =>
            !query.artistId || album.artistId === Number(query.artistId)
        ),
      ];
    }
    if (method === 'POST' && path === '/api/v1/artist') {
      const artist = { ...(body as object), id: nextId++ } as LidarrArtist;
      fake.artists.push(artist);
      return [201, artist];
    }
    if (method === 'POST' && path === '/api/v1/album') {
      const given = body as unknown as LidarrAlbum & {
        artist: Partial<LidarrArtist>;
      };
      let artist = fake.artists.find((a) => a.id === given.artist.id);
      if (!artist) {
        artist = { ...given.artist, id: nextId++ } as LidarrArtist;
        fake.artists.push(artist);
      }
      const album = {
        ...given,
        id: nextId++,
        artistId: artist.id,
        artist,
      } as LidarrAlbum;
      fake.albums.push(album);
      return [201, album];
    }
    if (method === 'PUT' && path.startsWith('/api/v1/artist/')) {
      return [202, body];
    }
    if (method === 'PUT' && path === '/api/v1/album/monitor') {
      return [202, {}];
    }
    if (method === 'POST' && path === '/api/v1/command') {
      return [201, { id: 1, ...body }];
    }
    if (method === 'GET' && path === '/api/v1/tag') {
      return [200, fake.tags];
    }
    if (method === 'POST' && path === '/api/v1/tag') {
      const tag = { id: nextId++, label: String(body?.label) };
      fake.tags.push(tag);
      return [201, tag];
    }
    return [404, { message: 'Not found' }];
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://lidarr');
      const call: LidarrCall = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: raw ? JSON.parse(raw) : undefined,
      };
      fake.calls.push(call);
      const [status, data] = fake.down
        ? [500, { message: 'Lidarr is down' }]
        : answer(call);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data ?? {}));
    });
  });

  return fake;
};
