import type { ProwlarrRelease } from '@server/api/prowlarr';
import ProwlarrAPI, { AUDIO_CATEGORIES } from '@server/api/prowlarr';
import type { LidarrAlbum, LidarrArtist } from '@server/api/servarr/lidarr';
import { getRepository } from '@server/datasource';
import type { AgentAction, AgentRun } from '@server/entity/AgentRun';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import type BackfillJob from '@server/entity/BackfillJob';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { MusicRequestBody } from '@server/interfaces/api/requestInterfaces';
import type { AgentState, KnownRelease } from '@server/lib/agent/tools';
import { lookups, runTool } from '@server/lib/agent/tools';
import backfill from '@server/lib/backfill/engine';
import type {
  AlbumTrack,
  AlbumTrackFile,
  LidarrParseResult,
} from '@server/lib/backfill/lidarr';
import BackfillLidarr from '@server/lib/backfill/lidarr';
import type { PackFile } from '@server/lib/backfill/matcher';
import type { SonarrQualityProfile } from '@server/lib/backfill/sonarr';
import type { LidarrSettings } from '@server/lib/settings';
import { BACKFILL_DEFAULTS, getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

setupTestDb();

/*
 * The admin agent with albums: finding one in Lidarr, reading its tracks,
 * searching Prowlarr's music, and downloading a release whose files
 * Backfill matches to the album's tracks. Lidarr and Prowlarr are stubbed
 * at their API clients, with the shapes Lidarr gives.
 */

const MB = 1024 ** 2;
const FLAC = { quality: { id: 6, name: 'FLAC' } };

const PROFILE: SonarrQualityProfile = {
  id: 1,
  name: 'Lossless',
  upgradeAllowed: true,
  cutoff: 6,
  items: [
    { quality: { id: 2, name: 'MP3-320' }, allowed: true },
    { quality: { id: 6, name: 'FLAC' }, allowed: true },
  ],
  minFormatScore: 0,
  cutoffFormatScore: 0,
};

const ARTIST = {
  id: 7,
  artistName: 'Glasswing',
  foreignArtistId: '3c9e5f21-8d47-4b6a-a1e3-5f7d2c90b844',
  monitored: true,
  qualityProfileId: 1,
  metadataProfileId: 1,
  path: '/music/Glasswing',
  tags: [],
  added: '2020-01-01T00:00:00Z',
} as LidarrArtist;

const ALBUM: LidarrAlbum = {
  id: 70,
  title: 'Static Garden',
  foreignAlbumId: '4f6a2d93-c1e8-3a57-9b02-6d3e8f1c7a40',
  artistId: 7,
  monitored: true,
  albumType: 'Album',
  releaseDate: '2001-05-01T00:00:00Z',
  releases: [
    {
      id: 9,
      albumId: 70,
      foreignReleaseId: 'standard',
      title: 'Static Garden',
      status: 'Official',
      trackCount: 3,
      format: 'Digital Media',
      monitored: true,
    },
  ],
  statistics: {
    trackCount: 3,
    trackFileCount: 1,
    totalTrackCount: 3,
    sizeOnDisk: 30 * MB,
    percentOfTracks: 33,
  },
};

const OTHER: LidarrAlbum = {
  ...ALBUM,
  id: 71,
  title: 'Fog Bank',
  foreignAlbumId: '9d1b7c22-5e3f-4a80-b6d4-1f2e3a4b5c6d',
  monitored: false,
};

const track = (
  id: number,
  number: number,
  title: string,
  fileId = 0
): AlbumTrack => ({
  id,
  albumId: 70,
  title,
  absoluteTrackNumber: number,
  albumReleaseId: 9,
  hasFile: fileId > 0,
  trackFileId: fileId,
});

const TRACKS = [
  track(501, 1, 'Opening', 900),
  track(502, 2, 'Lantern Song'),
  track(503, 3, 'Tide Pool'),
];

const ON_DISK: AlbumTrackFile[] = [
  { id: 900, albumId: 70, size: 30 * MB, quality: FLAC },
];

/** Lidarr's parser: this album by name, or none. */
const parse = (title: string): LidarrParseResult => ({
  title,
  parsedAlbumInfo: {
    quality: /flac/i.test(title) ? FLAC : { quality: { id: 0, name: '' } },
  },
  albums: /Static Garden/i.test(title)
    ? [{ id: 70, title: 'Static Garden' }]
    : [],
  customFormatScore: 0,
});

const FOLDER = 'Glasswing - Static Garden (2001) [FLAC]';
const PACK: PackFile[] = [
  { index: 0, path: `${FOLDER}/01 - Opening.flac`, size: 30 * MB },
  { index: 1, path: `${FOLDER}/02 - Lantern Song.flac`, size: 30 * MB },
  { index: 2, path: `${FOLDER}/03 - Tide Pool.flac`, size: 30 * MB },
  { index: 3, path: `${FOLDER}/cover.jpg`, size: MB },
];

const release = (title: string, ref = 'r1'): KnownRelease => ({
  ref,
  source: 'prowlarr',
  guid: `https://indexer/${ref}`,
  title,
  size: 95 * MB,
  indexerId: 3,
  indexer: 'Uindex',
  protocol: 'torrent',
  seeders: 40,
  downloadUrl: `http://prowlarr:9696/3/download?ref=${ref}`,
});

let actions: AgentAction[];
let approved: number[];
let searchedWith: number[] | undefined;
let packFiles: PackFile[];

const stateFor = (...known: KnownRelease[]): AgentState =>
  ({
    // An admin asked: every tool is open to it.
    run: {
      id: 1,
      trigger: 'ask',
      steps: [],
      actions: [],
      kind: null,
      arrId: null,
    } as unknown as AgentRun,
    user: { id: 1, displayName: 'Admin' },
    releases: new Map(known.map((k) => [k.ref, k])),
    files: new Map(),
    series: new Map(),
    movies: new Map(),
    grabsToday: 0,
    bind: () => undefined,
    act: (action: AgentAction) => actions.push(action),
    ask: () => undefined,
    propose: () => undefined,
  }) as unknown as AgentState;

const forServer = BackfillLidarr.forServer;

beforeEach(() => {
  actions = [];
  approved = [];
  searchedWith = undefined;
  packFiles = PACK;
  const settings = getSettings();
  settings.backfill = {
    ...BACKFILL_DEFAULTS,
    enabled: true,
    prowlarr: {
      ...BACKFILL_DEFAULTS.prowlarr,
      hostname: 'prowlarr',
      apiKey: 'k',
    },
    torrentClientId: 1,
    includeMusic: true,
  };
  settings.sonarr = [];
  settings.radarr = [];
  settings.lidarr = [
    {
      id: 0,
      name: 'Lidarr',
      hostname: 'lidarr',
      port: 8686,
      apiKey: 'x',
      useSsl: false,
      isDefault: true,
    } as unknown as LidarrSettings,
  ];
  settings.main.disabledFeatures = [];
  settings.downloadClients = [
    {
      id: 1,
      name: 'qBittorrent',
      type: 'qbittorrent',
      hostname: 'qbittorrent',
      port: 8080,
      useSsl: false,
      urlBase: '',
      apiKey: '',
      username: '',
      password: '',
    },
  ];

  const lidarr = BackfillLidarr.prototype;
  mock.method(lidarr, 'getAlbumDetail', async (id: number) =>
    id === OTHER.id ? OTHER : ALBUM
  );
  mock.method(lidarr, 'getArtistDetail', async () => ARTIST);
  mock.method(lidarr, 'getAlbumTracks', async () => TRACKS);
  mock.method(lidarr, 'getAlbumTrackFiles', async () => ON_DISK);
  mock.method(lidarr, 'getAlbumQueueCount', async () => 0);
  mock.method(lidarr, 'getQualityProfile', async () => PROFILE);
  mock.method(lidarr, 'parse', async (title: string) => parse(title));
  // Each client's own, not the class's.
  mock.method(BackfillLidarr, 'forServer', (server: LidarrSettings) =>
    Object.assign(forServer.call(BackfillLidarr, server), {
      getAlbums: async () => [ALBUM, OTHER],
      getArtists: async () => [ARTIST],
    })
  );
  mock.method(
    ProwlarrAPI.prototype,
    'search',
    async (_query: string, options: { categories?: number[] }) => {
      searchedWith = options.categories;
      return [release(FOLDER) as ProwlarrRelease];
    }
  );
  // Films and series on TMDB: none here.
  mock.method(lookups, 'tmdb', async () => ({ results: [] }));
  mock.method(backfill, 'filesOf', async () => ({ files: packFiles }));
  mock.method(backfill, 'approve', async (candidateId: number) => {
    approved.push(candidateId);
    return { id: 55, stage: '', indexerWait: false } as unknown as BackfillJob;
  });
});

afterEach(() => mock.restoreAll());

describe('the admin agent and albums', () => {
  it('finds an album in Lidarr by its name or its artist, and reads its tracks', async () => {
    const state = stateFor();
    const found = await runTool(state, 'find_title', {
      query: 'static garden',
    });
    assert.equal(found.isError, false, found.text);
    assert.match(
      found.text,
      /album:0:70 {2}Static Garden by Glasswing \(2001\) — album in Lidarr, 1 of 3 tracks on disk/
    );
    assert.doesNotMatch(found.text, /Fog Bank/);
    const byArtist = await runTool(state, 'find_title', { query: 'glasswing' });
    assert.match(byArtist.text, /album:0:70 /);
    assert.match(byArtist.text, /album:0:71 {2}Fog Bank .* not monitored/);

    const status = await runTool(state, 'title_status', {
      title: 'album:0:70',
    });
    assert.equal(status.isError, false, status.text);
    assert.match(status.text, /Static Garden by Glasswing \(2001\)/);
    assert.match(status.text, /quality profile Lossless/);
    assert.match(status.text, /1 of 3 tracks on disk/);
    assert.match(status.text, /1\. "Opening" on disk \(FLAC\)/);
    assert.match(status.text, /2\. "Lantern Song" missing/);
    assert.match(status.text, /Backfill: not following it yet/);
  });

  it("searches Prowlarr's music categories for music", async () => {
    const found = await runTool(stateFor(), 'search_indexers', {
      query: 'Glasswing Static Garden',
      kind: 'music',
    });
    assert.equal(found.isError, false, found.text);
    assert.deepEqual(searchedWith, AUDIO_CATEGORIES);
    assert.match(found.text, /r1 .*Glasswing - Static Garden/);
  });

  it('downloads the tracks a release fills, matched by Backfill, without being told the files', async () => {
    const state = stateFor(release(FOLDER));
    const grabbed = await runTool(state, 'grab', {
      title: 'album:0:70',
      release: 'r1',
      reason: 'The whole album in FLAC, well seeded.',
    });
    assert.equal(grabbed.isError, false, grabbed.text);
    assert.match(grabbed.text, /Started Backfill job #55: 2 files/);
    assert.match(grabbed.text, /for 2 tracks/);
    assert.match(grabbed.text, /has Lidarr import each/);
    assert.equal(approved.length, 1);
    const candidate = await getRepository(BackfillCandidate).findOneOrFail({
      where: { id: approved[0] },
    });
    // The track on disk is left alone; the other two fill what is missing,
    // into the edition Lidarr imports into.
    assert.deepEqual(
      candidate.plan.map((e) => [e.index, e.episodeIds, e.action, e.releaseId]),
      [
        [1, [502], 'fill', 9],
        [2, [503], 'fill', 9],
      ]
    );
    assert.equal(actions[0]?.type, 'grab');
    assert.equal(actions[0]?.title, 'Static Garden by Glasswing');
  });

  it("says why a release fills nothing, and doesn't start it", async () => {
    packFiles = [
      { index: 0, path: 'Glasswing - Fog Bank/01 - Haze.flac', size: 30 * MB },
    ];
    const state = stateFor(release('Glasswing - Fog Bank (2004) [FLAC]'));
    const grabbed = await runTool(state, 'grab', {
      title: 'album:0:70',
      release: 'r1',
      reason: 'It might be it.',
    });
    assert.equal(grabbed.isError, true);
    assert.match(grabbed.text, /Nothing was started/);
    assert.match(grabbed.text, /Not this album/);
    assert.equal(approved.length, 0);
  });

  it('leaves albums alone when Backfill does not do music', async () => {
    getSettings().backfill = {
      ...getSettings().backfill,
      includeMusic: false,
    };
    const state = stateFor(release(FOLDER));
    const found = await runTool(state, 'find_title', {
      query: 'static garden',
    });
    assert.doesNotMatch(found.text, /album:/);
    const grabbed = await runTool(state, 'grab', {
      title: 'album:0:70',
      release: 'r1',
      reason: 'The whole album.',
    });
    assert.equal(grabbed.isError, true);
    assert.match(grabbed.text, /Backfill does not do music now/);
    assert.equal(approved.length, 0);
  });

  it('turns down what does not apply to music', async () => {
    const state = stateFor(release(FOLDER));
    const language = await runTool(state, 'check_language', {
      title: 'album:0:70',
      release: 'r1',
    });
    assert.equal(language.isError, true);
    assert.match(language.text, /no audio language to check/);
    const change = await runTool(state, 'propose_change', {
      kind: 'deleteFiles',
      title: 'album:0:70',
      reason: 'The admin asked to delete it.',
    });
    assert.equal(change.isError, true);
    assert.match(change.text, /only blockGroup and unblockGroup/);
    const relink = await runTool(state, 'relink_file', {
      title: 'album:0:70',
      season: 1,
      episodes: [1, 2],
      reason: 'no',
    });
    assert.equal(relink.isError, true);
  });

  it('finds an album not in Lidarr on MusicBrainz, and requests it for its artist', async () => {
    const MBID = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';
    mock.method(lookups, 'albums', async () => [
      {
        mediaType: 'album',
        id: MBID,
        title: 'Paper Moons',
        primaryType: 'Album',
        secondaryTypes: [],
        releaseDate: '2018-03-09',
        artistName: 'Glasswing',
        coverUrl: '',
      },
    ]);
    mock.method(lookups, 'albumArtist', async () => ({
      title: 'Paper Moons',
      artistMbid: ARTIST.foreignArtistId,
      artist: 'Glasswing',
    }));
    const asked: MusicRequestBody[] = [];
    mock.method(
      MediaRequest,
      'requestMusic',
      async (body: MusicRequestBody) => {
        asked.push(body);
        return { id: 31 } as MediaRequest;
      }
    );
    const state = stateFor();
    const plain = await runTool(state, 'find_title', { query: 'paper moons' });
    assert.doesNotMatch(plain.text, /mb:album/);
    assert.match(plain.text, /look again with music: true/);
    const found = await runTool(state, 'find_title', {
      query: 'paper moons',
      music: true,
    });
    assert.match(
      found.text,
      new RegExp(
        `mb:album:${MBID} {2}Paper Moons by Glasswing \\(2018\\), Album — on MusicBrainz, in Seerr: not requested`
      )
    );
    const requested = await runTool(state, 'request_title', {
      album: `mb:album:${MBID}`,
    });
    assert.equal(requested.isError, false, requested.text);
    assert.match(
      requested.text,
      /Requested Paper Moons by Glasswing \(request #31\)/
    );
    assert.deepEqual(asked, [
      { artistMbid: ARTIST.foreignArtistId, albums: [MBID] },
    ]);
    assert.equal(actions[0]?.type, 'request');
    const wrong = await runTool(state, 'request_title', {
      album: 'Paper Moons',
    });
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /Use an album reference/);
  });
});
