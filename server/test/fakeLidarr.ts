import type {
  LidarrAlbum,
  LidarrArtist,
  LidarrTrack,
} from '@server/api/servarr/lidarr';
import type { LidarrSettings } from '@server/lib/settings';
import http from 'node:http';

// A local Lidarr for tests: answers the calls Seerr makes for music requests
// from test-provided data, and records every call in order so tests can assert
// what was and wasn't called.

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
  /** Each album's tracks, by its Lidarr id. */
  tracks: Map<number, LidarrTrack[]>;
  /** Tracks an album gets once added, by MusicBrainz id. */
  tracksOnAdd: Map<string, Omit<LidarrTrack, 'albumId'>[]>;
  /**
   * Each release's tracks, by Lidarr id. An album's `tracks` are its monitored
   * release's; a manual import into another release makes that one monitored,
   * as Lidarr does.
   */
  releaseTracks: Map<number, LidarrTrack[]>;
  /** Download client folders as Lidarr sees them. */
  remotePathMappings: { host: string; remotePath: string; localPath: string }[];
  /** Lidarr's delay profiles; its default prefers Usenet. */
  delayProfiles: {
    id: number;
    enableUsenet: boolean;
    enableTorrent: boolean;
    preferredProtocol: 'usenet' | 'torrent';
    order: number;
    tags: number[];
  }[];
  /** Lidarr's download queue. */
  queue: Record<string, unknown>[];
  /** The final status of every command. */
  commandStatus: string;
  /**
   * One-off answers by method and path ("POST /api/v1/album"), after running
   * `before` (e.g. a concurrent change landing).
   */
  once: Map<string, { status: number; body: unknown; before?: () => void }>;
  /** What manual import finds, by folder. */
  folders: Map<string, { path: string; size?: number }[]>;
  /** Whether manual import accepts its files (or rejects them all). */
  importTakes: boolean;
  tags: { id: number; label: string }[];
  /** While set, every call gets a server error. */
  down: boolean;
  /** Paths that get a server error; the rest answer normally. */
  failing: Set<string>;
  settings: (overrides?: Partial<LidarrSettings>) => LidarrSettings;
  reset: () => void;
  start: () => Promise<void>;
  stop: () => void;
  /**
   * Resolves once a matching call is made (or after a timeout), plus a moment
   * for Seerr's follow-up.
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
    tracks: new Map(),
    tracksOnAdd: new Map(),
    releaseTracks: new Map(),
    remotePathMappings: [],
    folders: new Map(),
    queue: [],
    commandStatus: 'completed',
    once: new Map(),
    delayProfiles: [
      {
        id: 1,
        enableUsenet: true,
        enableTorrent: true,
        preferredProtocol: 'usenet',
        order: 2147483647,
        tags: [],
      },
    ],
    importTakes: true,
    tags: [],
    down: false,
    failing: new Set(),
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
      fake.tracks = new Map();
      fake.tracksOnAdd = new Map();
      fake.releaseTracks = new Map();
      fake.remotePathMappings = [];
      fake.folders = new Map();
      fake.queue = [];
      fake.commandStatus = 'completed';
      fake.once = new Map();
      fake.delayProfiles = [
        {
          id: 1,
          enableUsenet: true,
          enableTorrent: true,
          preferredProtocol: 'usenet',
          order: 2147483647,
          tags: [],
        },
      ];
      fake.importTakes = true;
      fake.tags = [];
      fake.down = false;
      fake.failing = new Set();
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
      // Let Seerr record the outcome before the test checks.
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
            (!query.artistId || album.artistId === Number(query.artistId)) &&
            (!query.foreignAlbumId ||
              album.foreignAlbumId === query.foreignAlbumId)
        ),
      ];
    }
    if (method === 'GET' && path === '/api/v1/track') {
      if (query.albumReleaseId) {
        const id = Number(query.albumReleaseId);
        const owner = fake.albums.find((a) =>
          a.releases?.some((release) => release.id === id)
        );
        return [
          200,
          fake.releaseTracks.get(id) ??
            (owner ? (fake.tracks.get(owner.id) ?? []) : []),
        ];
      }
      return [200, fake.tracks.get(Number(query.albumId)) ?? []];
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
      // Lidarr's own validation: the full artist, new or not.
      if (
        !given.artist?.foreignArtistId ||
        !(Number(given.artist.qualityProfileId) > 0) ||
        !(Number(given.artist.metadataProfileId) > 0) ||
        !(given.artist.rootFolderPath || given.artist.path)
      ) {
        return [
          400,
          [{ propertyName: 'Artist.ForeignArtistId', errorMessage: 'empty' }],
        ];
      }
      // Lidarr keeps each album once, under one artist.
      if (fake.albums.some((a) => a.foreignAlbumId === given.foreignAlbumId)) {
        return [
          400,
          [
            {
              propertyName: 'ForeignAlbumId',
              errorMessage: 'This album has already been added.',
            },
          ],
        ];
      }
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
      const tracks = fake.tracksOnAdd.get(album.foreignAlbumId);
      if (tracks) {
        fake.tracks.set(
          album.id,
          tracks.map((track) => ({ ...track, albumId: album.id }))
        );
      }
      return [201, album];
    }
    if (method === 'PUT' && path.startsWith('/api/v1/artist/')) {
      return [202, body];
    }
    if (method === 'PUT' && path === '/api/v1/album/monitor') {
      return [202, {}];
    }
    if (method === 'POST' && path === '/api/v1/command') {
      // Manual import assigns each track its file and monitors the target
      // release, as Lidarr does.
      if (body?.name === 'ManualImport' && fake.importTakes) {
        for (const file of (body.files ?? []) as {
          albumId: number;
          albumReleaseId: number;
          trackIds: number[];
        }[]) {
          const album = fake.albums.find((a) => a.id === file.albumId);
          if (album?.releases?.some((r) => r.id === file.albumReleaseId)) {
            album.releases = album.releases.map((release) => ({
              ...release,
              monitored: release.id === file.albumReleaseId,
            }));
            const own = fake.releaseTracks.get(file.albumReleaseId);
            if (own) fake.tracks.set(album.id, own);
          }
          for (const tracks of [
            ...fake.tracks.values(),
            ...fake.releaseTracks.values(),
          ]) {
            for (const track of tracks) {
              if (file.trackIds.includes(track.id)) track.hasFile = true;
            }
          }
        }
      }
      return [201, { id: 1, ...body }];
    }
    if (method === 'GET' && path.startsWith('/api/v1/command/')) {
      return [
        200,
        { id: Number(path.split('/').pop()), status: fake.commandStatus },
      ];
    }
    if (method === 'GET' && path === '/api/v1/remotepathmapping') {
      return [200, fake.remotePathMappings];
    }
    if (method === 'GET' && path === '/api/v1/queue') {
      return [
        200,
        {
          page: 1,
          pageSize: fake.queue.length,
          totalRecords: fake.queue.length,
          records: fake.queue,
        },
      ];
    }
    if (method === 'GET' && path === '/api/v1/delayprofile') {
      return [200, fake.delayProfiles];
    }
    if (method === 'GET' && path === '/api/v1/manualimport') {
      return [200, fake.folders.get(query.folder ?? '') ?? []];
    }
    if (method === 'GET' && /^\/api\/v1\/album\/\d+$/.test(path)) {
      const album = fake.albums.find(
        (a) => a.id === Number(path.split('/').pop())
      );
      return album ? [200, album] : [404, { message: 'Not found' }];
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
      const once = fake.once.get(`${call.method} ${call.path}`);
      if (once) {
        fake.once.delete(`${call.method} ${call.path}`);
        once.before?.();
      }
      const [status, data] = once
        ? [once.status, once.body]
        : fake.down || fake.failing.has(call.path)
          ? [500, { message: 'Lidarr is down' }]
          : answer(call);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data ?? {}));
    });
  });

  return fake;
};
