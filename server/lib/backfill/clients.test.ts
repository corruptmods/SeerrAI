import ProwlarrAPI from '@server/api/prowlarr';
import { getRepository } from '@server/datasource';
import BackfillCandidate from '@server/entity/BackfillCandidate';
import BackfillJob from '@server/entity/BackfillJob';
import BackfillSeries from '@server/entity/BackfillSeries';
import backfill from '@server/lib/backfill/engine';
import backfillNotices from '@server/lib/backfill/notices';
import type { PlanEntry } from '@server/lib/backfill/plan';
import type { SonarrEpisode } from '@server/lib/backfill/sonarr';
import BackfillSonarr from '@server/lib/backfill/sonarr';
import notificationManager from '@server/lib/notifications';
import type { DownloadClientType, SonarrSettings } from '@server/lib/settings';
import { BACKFILL_DEFAULTS, getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';
import { parseStringPromise } from 'xml2js';

setupTestDb();

/*
 * Backfill with every download client, end to end: the engine and each
 * client's own API code, against a stand-in that speaks that client's
 * protocol and keeps its torrents (or NZB jobs) as the client would. A pack
 * is approved, only its chosen file downloads, Sonarr imports it, and the
 * download is removed with its data. Prowlarr and Sonarr are stubbed at
 * their API clients.
 */

const ben = (value: unknown): Buffer => {
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([Buffer.from(`${b.length}:`), b]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      Buffer.from('l'),
      ...value.map(ben),
      Buffer.from('e'),
    ]);
  }
  const dict = value as Record<string, unknown>;
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(dict)
      .sort()
      .flatMap((k) => [ben(k), ben(dict[k])]),
    Buffer.from('e'),
  ]);
};

const NAME = '[Tengu] Kitsuraga';
const FILES = [
  { length: 400, path: ['S3', '[Tengu] Kitsuraga - S03E06 (101).mkv'] },
  { length: 300, path: ['S3', '[Tengu] Kitsuraga - S03E07 (102).mkv'] },
  { length: 200, path: ['S1', '[Tengu] Kitsuraga - S01E01 (001).mkv'] },
];
const INFO = {
  name: NAME,
  'piece length': 4194304,
  pieces: Buffer.alloc(20),
  files: FILES,
};
const TORRENT = ben({ announce: 'udp://tracker', info: INFO });
const HASH = createHash('sha1').update(ben(INFO)).digest('hex');
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Kitsuraga`;
const NZB = Buffer.from('<nzb/>');

const quality = {
  quality: { id: 7, name: 'Bluray-1080p' },
  revision: { version: 1, real: 0 },
};
const entry = (index: number, episodeId: number): PlanEntry => ({
  index,
  path: `${NAME}/${FILES[index].path.join('/')}`,
  size: FILES[index].length,
  judgedAs: FILES[index].path[1],
  episodeIds: [episodeId],
  absolute: episodeId,
  quality,
  languages: [{ id: 8, name: 'Japanese' }],
  releaseGroup: 'Tengu',
  score: 700,
  action: index === 0 ? 'fill' : 'skip',
  replaces: 0,
});

const ep = (id: number, hasFile: boolean): SonarrEpisode => ({
  id,
  seriesId: 1279,
  seasonNumber: 3,
  episodeNumber: id,
  absoluteEpisodeNumber: id,
  hasFile,
  monitored: true,
  episodeFileId: hasFile ? 900 : 0,
  airDateUtc: '2005-01-01T00:00:00Z',
});

/* ------------------------- the clients' stand-ins ------------------------ */

/** A torrent as a stand-in client holds it. */
interface Held {
  hash: string;
  wanted: boolean[];
  started: boolean;
  /** A magnet link whose file list has not come yet. */
  waiting: boolean;
  label?: string;
  /** Download speed held down (Transmission's and Deluge's). */
  capped: boolean;
  /** Deluge's own "remove at ratio" for it, when it was given one. */
  removeAtRatio?: boolean;
}

/** What every stand-in shares: its torrents, and what was done to them. */
const swarm = {
  torrents: new Map<string, Held>(),
  /** The chosen files are all in. */
  done: false,
  removed: [] as { hash: string; withData: boolean }[],
  commands: [] as string[][],
  reset() {
    this.torrents.clear();
    this.done = false;
    this.removed = [];
    this.commands = [];
  },
  add(hash: string, started: boolean, waiting: boolean, label?: string) {
    this.torrents.set(hash, {
      hash,
      wanted: FILES.map(() => true),
      started,
      waiting,
      label,
      capped: false,
    });
    return this.torrents.get(hash)!;
  },
  progress(held: Held, index: number) {
    return this.done && held.wanted[index] ? 1 : 0;
  },
  complete(held: Held) {
    return held.wanted.every((w, i) => !w || this.progress(held, i) === 1);
  },
};

const SAVE = '/downloads';
const ADDED = Math.floor(Date.now() / 1000) - 3600;

const body = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw));
  });

const transmission: http.RequestListener = async (req, res) => {
  const { method, arguments: args = {} } = JSON.parse(await body(req));
  if (req.headers['x-transmission-session-id'] !== 's1') {
    res.statusCode = 409;
    res.setHeader('X-Transmission-Session-Id', 's1');
    return res.end();
  }
  const answer = (result: unknown = {}) =>
    res.end(JSON.stringify({ result: 'success', arguments: result }));
  const ids = (args.ids as string[] | undefined)?.map((id) => id.toLowerCase());
  const each = (fn: (held: Held) => void) =>
    ids?.forEach((id) => swarm.torrents.get(id) && fn(swarm.torrents.get(id)!));
  switch (method) {
    case 'session-get':
      return answer({ version: '4.0.6', 'rpc-version': 17 });
    case 'torrent-add': {
      const held = swarm.add(HASH, !args.paused, !!args.filename);
      return answer({ 'torrent-added': { hashString: held.hash, id: 1 } });
    }
    case 'torrent-set':
      each((held) => {
        if (args.labels) held.label = args.labels[0];
        if ('downloadLimited' in args) held.capped = args.downloadLimited;
        for (const i of args['files-wanted'] ?? []) held.wanted[i] = true;
        for (const i of args['files-unwanted'] ?? []) held.wanted[i] = false;
      });
      return answer();
    case 'torrent-start':
      each((held) => (held.started = true));
      return answer();
    case 'torrent-stop':
      each((held) => (held.started = false));
      return answer();
    case 'torrent-remove':
      each((held) => {
        swarm.torrents.delete(held.hash);
        swarm.removed.push({
          hash: held.hash,
          withData: !!args['delete-local-data'],
        });
      });
      return answer();
    case 'torrent-get': {
      const torrents = [...swarm.torrents.values()]
        .filter((held) => !ids || ids.includes(held.hash))
        .map((held) => {
          const complete = swarm.complete(held);
          const wantedSize = FILES.reduce(
            (n, f, i) => n + (held.wanted[i] ? f.length : 0),
            0
          );
          return {
            hashString: held.hash,
            name: held.waiting ? HASH : NAME,
            status: !held.started ? 0 : complete ? 6 : 4,
            error: 0,
            percentDone: complete ? 1 : 0,
            rateDownload: held.started && !complete ? 1000 : 0,
            eta: -1,
            downloadDir: SAVE,
            addedDate: ADDED,
            sizeWhenDone: held.waiting ? 0 : wantedSize,
            leftUntilDone: complete ? 0 : wantedSize,
            metadataPercentComplete: held.waiting ? 0 : 1,
            labels: held.label ? [held.label] : [],
            files: held.waiting
              ? []
              : FILES.map((f, i) => ({
                  name: [NAME, ...f.path].join('/'),
                  length: f.length,
                  bytesCompleted: f.length * swarm.progress(held, i),
                })),
          };
        });
      return answer({ torrents });
    }
  }
  res.end(JSON.stringify({ result: `no method ${method}` }));
};

const deluge: http.RequestListener = async (req, res) => {
  const { method, params = [], id } = JSON.parse(await body(req));
  const answer = (result: unknown = null) =>
    res.end(JSON.stringify({ result, error: null, id }));
  if (method === 'auth.login') {
    res.setHeader('Set-Cookie', '_session_id=d1; Path=/json');
    return answer(params[0] === 'deluge');
  }
  const status = (held: Held) => {
    const complete = swarm.complete(held);
    const wanted = held.waiting
      ? 0
      : FILES.reduce((n, f, i) => n + (held.wanted[i] ? f.length : 0), 0);
    return {
      name: NAME,
      state: !held.started ? 'Paused' : complete ? 'Seeding' : 'Downloading',
      progress: complete ? 100 : 0,
      download_payload_rate: held.started && !complete ? 1000 : 0,
      eta: 0,
      save_path: SAVE,
      time_added: ADDED,
      message: 'OK',
      is_finished: complete && !held.waiting,
      total_wanted: wanted,
      total_done: complete ? wanted : 0,
      files: held.waiting
        ? []
        : FILES.map((f, index) => ({
            index,
            path: [NAME, ...f.path].join('/'),
            size: f.length,
          })),
      file_progress: FILES.map((_, i) => swarm.progress(held, i)),
      file_priorities: held.wanted.map((w) => (w ? 4 : 0)),
      label: held.label ?? '',
    };
  };
  const pick = (fields: string[], held: Held) =>
    Object.fromEntries(
      fields.map((f) => [f, (status(held) as Record<string, unknown>)[f]])
    );
  switch (method) {
    case 'web.connected':
      return answer(true);
    case 'daemon.get_version':
      return answer('2.1.1');
    case 'core.get_enabled_plugins':
      return answer(['Label']);
    case 'label.get_labels':
      return answer([]);
    case 'label.add':
      return answer();
    case 'label.set_torrent':
      swarm.torrents.get(params[0])!.label = params[1];
      return answer();
    case 'core.add_torrent_file':
    case 'core.add_torrent_magnet': {
      const options = params[params.length - 1];
      const held = swarm.add(
        HASH,
        !options.add_paused,
        method === 'core.add_torrent_magnet'
      );
      held.capped = options.max_download_speed > 0;
      held.removeAtRatio = options.remove_at_ratio;
      return answer(held.hash);
    }
    case 'core.get_torrent_status': {
      const held = swarm.torrents.get(params[0]);
      return answer(held ? pick(params[1], held) : {});
    }
    case 'core.get_torrents_status':
      return answer(
        Object.fromEntries(
          [...swarm.torrents.values()]
            .filter((held) => held.label === params[0].label)
            .map((held) => [held.hash, pick(params[1], held)])
        )
      );
    case 'core.set_torrent_options':
      for (const hash of params[0]) {
        const held = swarm.torrents.get(hash)!;
        if (params[1].file_priorities) {
          held.wanted = params[1].file_priorities.map((p: number) => p > 0);
        }
        if ('max_download_speed' in params[1]) {
          held.capped = params[1].max_download_speed > 0;
        }
      }
      return answer();
    case 'core.resume_torrent':
    case 'core.pause_torrent':
      for (const hash of params[0]) {
        swarm.torrents.get(hash)!.started = method === 'core.resume_torrent';
      }
      return answer();
    case 'core.remove_torrent':
      swarm.torrents.delete(params[0]);
      swarm.removed.push({ hash: params[0], withData: params[1] === true });
      return answer(true);
  }
  res.end(
    JSON.stringify({ result: null, error: { message: method, code: 2 }, id })
  );
};

type Xml = string | number | Buffer | Xml[] | { [k: string]: Xml };

/** One XML-RPC value, as rTorrent reads what it is sent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readValue = (value: any): Xml => {
  if (typeof value === 'string') return value;
  const [type, inner] = Object.entries(value)[0] as [string, unknown[]];
  const first = inner[0];
  switch (type) {
    case 'i4':
    case 'i8':
      return Number(first);
    case 'base64':
      return Buffer.from(String(first), 'base64');
    case 'array':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((first as any).data?.[0]?.value ?? []).map(readValue);
    case 'struct':
      return Object.fromEntries(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((first as any).member ?? []).map((m: any) => [
          m.name[0],
          readValue(m.value[0]),
        ])
      );
    default:
      return typeof first === 'string' ? first : '';
  }
};

const writeValue = (value: Xml): string =>
  typeof value === 'number'
    ? `<value><i8>${value}</i8></value>`
    : typeof value === 'string'
      ? `<value><string>${value
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')}</string></value>`
      : Array.isArray(value)
        ? `<value><array><data>${value.map(writeValue).join('')}</data></array></value>`
        : `<value><string></string></value>`;

const rtorrentCall = (method: string, params: Xml[]): Xml => {
  const target = String(params[0] ?? '').toLowerCase();
  const held = swarm.torrents.get(target.split(':')[0]);
  const meta = (h: Held) => h.waiting;
  switch (method) {
    case 'system.client_version':
      return '0.9.8';
    case 'load.raw_verbose':
    case 'load.start_verbose': {
      const commands = params.slice(2).map(String);
      const label = commands
        .find((c) => c.startsWith('d.custom1.set='))
        ?.slice('d.custom1.set='.length);
      swarm.add(
        HASH,
        method === 'load.start_verbose',
        method === 'load.start_verbose',
        label && decodeURIComponent(label)
      );
      return 0;
    }
    case 'd.multicall2':
      return [...swarm.torrents.values()].map((h) => {
        const complete = swarm.complete(h);
        return [
          h.hash.toUpperCase(),
          meta(h) ? `${h.hash.toUpperCase()}.meta` : NAME,
          h.started ? 1 : 0,
          h.started ? 1 : 0,
          h.started ? 1 : 0,
          complete && !meta(h) ? 1 : 0,
          900,
          complete ? 900 : 0,
          h.started && !complete ? 1000 : 0,
          0,
          '',
          meta(h) ? SAVE : `${SAVE}/${NAME}`,
          meta(h) ? 0 : 1,
          h.label ? encodeURIComponent(h.label) : '',
          String(ADDED),
        ];
      });
    case 'f.multicall':
      return meta(held!)
        ? [[`${HASH.toUpperCase()}.meta`, 0, 0, 1]]
        : FILES.map((f, i) => [
            f.path.join('/'),
            f.length,
            swarm.progress(held!, i),
            1,
          ]);
    case 'f.priority.set':
      held!.wanted[Number(target.split(':f')[1])] = Number(params[1]) > 0;
      return 0;
    case 'd.update_priorities':
    case 'd.open':
    case 'd.close':
      return 0;
    case 'd.start':
    case 'd.stop':
      held!.started = method === 'd.start';
      return 0;
    case 'd.erase':
      swarm.torrents.delete(target);
      swarm.removed.push({ hash: target, withData: false });
      return 0;
    case 'execute.throw':
      swarm.commands.push(params.slice(1).map(String));
      return 0;
  }
  throw new Error(`no method ${method}`);
};

const rtorrent: http.RequestListener = async (req, res) => {
  const doc = await parseStringPromise(await body(req));
  const method = doc.methodCall.methodName[0];
  const params: Xml[] = (doc.methodCall.params?.[0]?.param ?? []).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p: any) => readValue(p.value[0])
  );
  let result: Xml;
  if (method === 'system.multicall') {
    result = (params[0] as { methodName: string; params: Xml[] }[]).map((c) => [
      rtorrentCall(c.methodName, c.params),
    ]);
  } else {
    result = rtorrentCall(method, params);
  }
  res.setHeader('Content-Type', 'text/xml');
  res.end(
    `<?xml version="1.0"?><methodResponse><params><param>${writeValue(result)}</param></params></methodResponse>`
  );
};

/** NZBGet's jobs: the one Backfill adds, downloading until it is done. */
const nzb = {
  added: [] as { name: string; category: string; dupeMode: string }[],
  edits: [] as string[],
  done: false,
  reset() {
    this.added = [];
    this.edits = [];
    this.done = false;
  },
};

const nzbget: http.RequestListener = async (req, res) => {
  const { method, params = [] } = JSON.parse(await body(req));
  const answer = (result: unknown) =>
    res.end(JSON.stringify({ result, id: 1 }));
  const inQueue = nzb.added.length > 0 && !nzb.done;
  switch (method) {
    case 'version':
      return answer('24.3');
    case 'append':
      nzb.added.push({
        name: params[0],
        category: params[2],
        dupeMode: params[8],
      });
      return answer(21);
    case 'status':
      return answer({ DownloadRate: 2 * 1024 * 1024, DownloadPaused: false });
    case 'listgroups':
      return answer(
        inQueue
          ? [
              {
                NZBID: 21,
                Status: 'DOWNLOADING',
                FileSizeMB: 110,
                RemainingSizeMB: 60,
                PausedSizeMB: 10,
              },
            ]
          : []
      );
    case 'history':
      return answer(
        nzb.done
          ? [
              {
                NZBID: 21,
                Status: 'SUCCESS/ALL',
                FileSizeMB: 100,
                DestDir: '/complete/backfill/Kitsuraga.S03E06',
              },
            ]
          : []
      );
    case 'editqueue':
      nzb.edits.push(`${params[0]} ${params[2].join(',')}`);
      // Only what is where the command looks.
      return answer(params[0].startsWith('History') ? nzb.done : inQueue);
  }
  res.end(JSON.stringify({ error: { message: method }, id: 1 }));
};

/* --------------------------------- setup --------------------------------- */

const servers: http.Server[] = [];
const ports: Partial<Record<DownloadClientType, number>> = {};
let episodes: SonarrEpisode[] = [];
let imports: { path: string; episodeIds: number[] }[][] = [];

before(async () => {
  const listen = (type: DownloadClientType, handler: http.RequestListener) =>
    new Promise<void>((resolve) => {
      const server = http.createServer(handler).listen(0, () => {
        ports[type] = (server.address() as AddressInfo).port;
        resolve();
      });
      servers.push(server);
    });
  await listen('transmission', transmission);
  await listen('deluge', deluge);
  await listen('rtorrent', rtorrent);
  await listen('nzbget', nzbget);
});

after(() => servers.forEach((s) => s.close()));

/** Backfill sending to this client, the only one set up. */
const useClient = (type: DownloadClientType) => {
  const settings = getSettings();
  settings.downloadClients = [
    {
      id: 1,
      name: `My ${type}`,
      type,
      hostname: '127.0.0.1',
      port: ports[type]!,
      useSsl: false,
      urlBase: '',
      apiKey: '',
      username: '',
      password: type === 'deluge' ? 'deluge' : '',
    },
  ];
  const torrent = type !== 'nzbget';
  settings.backfill = {
    ...BACKFILL_DEFAULTS,
    enabled: true,
    prowlarr: { ...BACKFILL_DEFAULTS.prowlarr, hostname: 'p', apiKey: 'k' },
    torrentClientId: torrent ? 1 : null,
    usenetClientId: torrent ? null : 1,
    minFreeSpaceGb: 0,
  };
};

beforeEach(() => {
  swarm.reset();
  nzb.reset();
  backfillNotices.flush();
  episodes = [ep(101, false), ep(102, true)];
  imports = [];

  const settings = getSettings();
  settings.sonarr = [
    {
      id: 0,
      name: 'Sonarr',
      hostname: 'sonarr',
      port: 8989,
      apiKey: 'x',
      useSsl: false,
      activeProfileId: 13,
      activeDirectory: '/anime',
      isDefault: true,
    } as unknown as SonarrSettings,
  ];
  mock.method(notificationManager, 'sendNotification', () => undefined);
  mock.method(BackfillSonarr.prototype, 'getSeriesDetail', async () => ({
    id: 1279,
    title: 'Kitsuraga',
    year: 2002,
    tvdbId: 63914,
    seriesType: 'anime',
    qualityProfileId: 13,
    path: '/anime/Kitsuraga',
  }));
  mock.method(BackfillSonarr.prototype, 'getRootFoldersNow', async () => [
    { path: '/anime', freeSpace: 10 * 1024 ** 4 },
  ]);
  mock.method(
    BackfillSonarr.prototype,
    'getSeriesEpisodes',
    async () => episodes
  );
  mock.method(BackfillSonarr.prototype, 'getRemotePathMappings', async () => [
    {
      host: '127.0.0.1',
      remotePath: '/downloads/',
      localPath: '/data/torrents/',
    },
    { host: '127.0.0.1', remotePath: '/complete/', localPath: '/data/usenet/' },
  ]);
  mock.method(BackfillSonarr.prototype, 'getFolderFiles', async () => [
    {
      path: '/data/usenet/backfill/Kitsuraga.S03E06/[Tengu] Kitsuraga - S03E06 (101).mkv',
      name: '[Tengu] Kitsuraga - S03E06 (101).mkv',
      size: 400,
    },
  ]);
  mock.method(
    BackfillSonarr.prototype,
    'manualImport',
    async (files: { path: string; episodeIds: number[] }[]) => {
      imports.push(
        files.map((f) => ({ path: f.path, episodeIds: f.episodeIds }))
      );
      return 77;
    }
  );
  mock.method(BackfillSonarr.prototype, 'getCommand', async () => ({
    id: 77,
    name: 'ManualImport',
    status: 'completed',
  }));
});

afterEach(() => mock.restoreAll());

const seed = async (
  protocol: 'torrent' | 'usenet',
  fetched:
    | { kind: 'torrent'; data: Buffer }
    | { kind: 'magnet'; uri: string }
    | { kind: 'nzb'; data: Buffer }
) => {
  mock.method(ProwlarrAPI.prototype, 'fetchRelease', async () => fetched);
  const series = await getRepository(BackfillSeries).save(
    new BackfillSeries({
      serverId: 0,
      arrId: 1279,
      tmdbId: 58371,
      tvdbId: 63914,
      title: 'Kitsuraga',
      year: 2002,
      seriesType: 'anime',
      status: 'found',
      missing: 1,
      searchTerms: [],
    })
  );
  const plan =
    protocol === 'torrent'
      ? [entry(0, 101), entry(1, 102), entry(2, 1)]
      : [{ ...entry(0, 101), path: FILES[0].path[1] }];
  return getRepository(BackfillCandidate).save(
    new BackfillCandidate({
      seriesId: series.id,
      guid: `https://indexer/${protocol}`,
      title: '[Tengu] Kitsuraga (Complete Series) [BD 1080p]',
      indexer: 'Uindex',
      indexerId: 45,
      protocol,
      size: 900,
      seeders: 10,
      downloadUrl: 'http://prowlarr/download',
      status: 'ready',
      plan,
      summary: {
        fill: 1,
        upgrade: 0,
        skip: plan.length - 1,
        reject: 0,
        covered: 1,
        bytes: 400,
        fillBytes: 400,
        replaces: 0,
        quality: 'Bluray-1080p',
        score: 700,
        sonarrSeesTitle: false,
      },
    })
  );
};

const jobOf = (id: number) =>
  getRepository(BackfillJob).findOneOrFail({ where: { id } });

/* --------------------------------- tests --------------------------------- */

for (const type of ['transmission', 'deluge', 'rtorrent'] as const) {
  describe(`Backfill with ${type}`, () => {
    it('adds the .torrent stopped, downloads only the chosen file, imports it and removes the torrent with its data', async () => {
      useClient(type);
      const candidate = await seed('torrent', {
        kind: 'torrent',
        data: TORRENT,
      });
      const started = await backfill.approve(candidate.id, { mode: 'missing' });

      let job = await jobOf(started.id);
      assert.equal(
        job.status,
        'downloading',
        job.log.map((l) => l.message).join('\n')
      );
      assert.equal(job.downloadId, HASH);
      const held = swarm.torrents.get(HASH)!;
      assert.deepEqual(
        held.wanted,
        [true, false, false],
        'only the missing episode'
      );
      assert.equal(held.started, true);
      assert.equal(held.label, 'backfill');

      // Its progress, read live as a page would.
      const live = await backfill.liveProgress(job);
      assert.equal(live?.size, 400);
      assert.equal(live?.stage, 'Downloading');

      // Paused in the client: said in the client's own name.
      held.started = false;
      await backfill.tick();
      job = await jobOf(job.id);
      assert.match(
        job.stage ?? '',
        /^Paused in (Transmission|Deluge|rTorrent)$/
      );
      held.started = true;

      swarm.done = true;
      await backfill.tick();
      job = await jobOf(job.id);
      assert.equal(
        job.status,
        'importing',
        job.log.map((l) => l.message).join('\n')
      );
      assert.deepEqual(imports[0], [
        {
          path: '/data/torrents/[Tengu] Kitsuraga/S3/[Tengu] Kitsuraga - S03E06 (101).mkv',
          episodeIds: [101],
        },
      ]);

      episodes = [ep(101, true), ep(102, true)];
      await backfill.tick();
      job = await jobOf(job.id);
      assert.equal(
        job.status,
        'done',
        job.log.map((l) => l.message).join('\n')
      );
      assert.equal(swarm.torrents.size, 0);
      if (type === 'rtorrent') {
        // rTorrent's RPC removes no data: each file, then its empty folders.
        assert.deepEqual(swarm.commands, [
          ...FILES.map((f) => [
            'rm',
            '-f',
            '--',
            `${SAVE}/${NAME}/${f.path.join('/')}`,
          ]),
          ['rmdir', '--', `${SAVE}/${NAME}/S3`],
          ['rmdir', '--', `${SAVE}/${NAME}/S1`],
          ['rmdir', '--', `${SAVE}/${NAME}`],
        ]);
      } else {
        assert.deepEqual(swarm.removed, [{ hash: HASH, withData: true }]);
      }
    });

    it('fetches a magnet link’s file list, then chooses the files at once', async () => {
      useClient(type);
      const candidate = await seed('torrent', { kind: 'magnet', uri: MAGNET });
      // The swarm sends the file list a moment after the magnet is added.
      setTimeout(() => {
        const held = swarm.torrents.get(HASH);
        if (held) held.waiting = false;
      }, 500);
      const started = await backfill.approve(candidate.id, { mode: 'missing' });
      const job = await jobOf(started.id);
      assert.equal(
        job.stage,
        'Downloading',
        job.log.map((l) => l.message).join('\n')
      );
      const held = swarm.torrents.get(HASH)!;
      assert.deepEqual(held.wanted, [true, false, false]);
      assert.equal(held.started, true);
      assert.equal(held.capped, false, 'full speed once the files are chosen');
    });
  });
}

describe('Backfill with Deluge', () => {
  it('has Deluge stop the torrent once done, and never remove it before it is imported', async () => {
    useClient('deluge');
    const candidate = await seed('torrent', { kind: 'torrent', data: TORRENT });
    await backfill.approve(candidate.id, { mode: 'missing' });
    // Left to Deluge's own settings, one set to remove torrents at their
    // ratio would take this one, files and all, the moment it is done.
    assert.equal(swarm.torrents.get(HASH)?.removeAtRatio, false);
  });
});

describe('Backfill with NZBGet', () => {
  it('adds the NZB, follows it to the history, imports from its folder and removes the job', async () => {
    useClient('nzbget');
    const candidate = await seed('usenet', { kind: 'nzb', data: NZB });
    const started = await backfill.approve(candidate.id, { mode: 'missing' });
    let job = await jobOf(started.id);
    assert.equal(
      job.status,
      'downloading',
      job.log.map((l) => l.message).join('\n')
    );
    assert.equal(job.downloadId, '21');
    assert.equal(job.stage, 'Queued in NZBGet');
    assert.deepEqual(nzb.added, [
      {
        name: '[Tengu] Kitsuraga (Complete Series) [BD 1080p].nzb',
        category: 'backfill',
        dupeMode: 'FORCE',
      },
    ]);

    await backfill.tick();
    job = await jobOf(job.id);
    assert.equal(job.stage, 'Downloading');
    // The held-back repair files are not counted.
    assert.equal(job.size, 100 * 1024 * 1024);
    assert.equal(job.progress, 50);

    await backfill.pause(job.id);
    await backfill.resume(job.id);
    assert.deepEqual(nzb.edits, ['GroupPause 21', 'GroupResume 21']);

    nzb.done = true;
    await backfill.tick();
    job = await jobOf(job.id);
    assert.equal(
      job.status,
      'importing',
      job.log.map((l) => l.message).join('\n')
    );
    assert.deepEqual(imports[0], [
      {
        path: '/data/usenet/backfill/Kitsuraga.S03E06/[Tengu] Kitsuraga - S03E06 (101).mkv',
        episodeIds: [101],
      },
    ]);

    episodes = [ep(101, true), ep(102, true)];
    await backfill.tick();
    job = await jobOf(job.id);
    assert.equal(job.status, 'done', job.log.map((l) => l.message).join('\n'));
    assert.deepEqual(nzb.edits.slice(2), [
      'GroupFinalDelete 21',
      'HistoryFinalDelete 21',
    ]);
  });
});

describe('Backfill settings', () => {
  it('lists every torrent and Usenet client to choose from', () => {
    getSettings().downloadClients = (
      [
        'sabnzbd',
        'nzbget',
        'qbittorrent',
        'transmission',
        'deluge',
        'rtorrent',
      ] as const
    ).map((type, i) => ({
      id: i + 1,
      name: type,
      type,
      hostname: 'h',
      port: 1,
      useSsl: false,
      urlBase: '',
      apiKey: '',
      username: '',
      password: '',
    }));
    assert.deepEqual(
      backfill.clientsFor('torrent').map((c) => c.name),
      ['qbittorrent', 'transmission', 'deluge', 'rtorrent']
    );
    assert.deepEqual(
      backfill.clientsFor('usenet').map((c) => c.name),
      ['sabnzbd', 'nzbget']
    );
  });
});
