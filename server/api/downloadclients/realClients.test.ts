import DelugeAPI from '@server/api/downloadclients/deluge';
import NzbgetAPI from '@server/api/downloadclients/nzbget';
import QBittorrentAPI from '@server/api/downloadclients/qbittorrent';
import RtorrentAPI from '@server/api/downloadclients/rtorrent';
import SabnzbdAPI from '@server/api/downloadclients/sabnzbd';
import TransmissionAPI from '@server/api/downloadclients/transmission';
import type {
  TorrentClient,
  UsenetClient,
} from '@server/api/downloadclients/types';
import axios from 'axios';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join, posix } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { crc32 } from 'node:zlib';

/*
 * The download clients' code against the real clients, not stand-ins: a
 * stand-in only answers what its writer believed, which is how Deluge 2's
 * missing daemon.info, rTorrent never finishing a torrent with files
 * skipped, and SABnzbd refusing to delete a finished job each got by.
 *
 * Skipped unless REAL_CLIENTS is set: "all", or some of deluge,
 * qbittorrent, transmission, rtorrent, nzbget, sabnzbd. CI's "Real
 * download clients" workflow starts each one first; where each one is,
 * and how it signs in, can be set by REAL_<CLIENT>_{HOST,PORT,USER,PASS}
 * (and REAL_SABNZBD_KEY). A client in a container names its own paths:
 * REAL_<CLIENT>_PATHS ("/downloads=/srv/deluge,…") says where they are
 * here. A tiny news server is run here for the Usenet clients.
 */

const wanted = (process.env.REAL_CLIENTS ?? '').toLowerCase();
const on = (name: string) =>
  wanted === 'all' || wanted.split(',').includes(name.toLowerCase());
const skip = !wanted;

const env = (name: string, fallback: string) =>
  process.env[`REAL_${name}`] || fallback;
const where = (name: string, port: number) => ({
  hostname: env(`${name}_HOST`, '127.0.0.1'),
  port: Number(env(`${name}_PORT`, String(port))),
  useSsl: false,
  urlBase: '',
  apiKey: '',
});

/** A client's own path, as it is here. */
const local = (client: string, path: string) => {
  const pairs = [
    process.env[`REAL_${client.toUpperCase()}_PATHS`],
    process.env.REAL_CLIENTS_PATHS,
  ];
  for (const pair of pairs.filter(Boolean).join(',').split(',')) {
    const [theirs, ours] = pair.split('=');
    if (theirs && ours && (path === theirs || path.startsWith(`${theirs}/`))) {
      return ours + path.slice(theirs.length);
    }
  }
  return path;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asks until `ok`, for up to `ms`; a request that fails is asked again. */
const until = async <T>(
  what: string,
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  ms = 30_000
): Promise<T> => {
  const end = Date.now() + ms;
  let last: { value: T } | { error: string };
  for (;;) {
    try {
      last = { value: await read() };
      if (ok(last.value)) return last.value;
    } catch (e) {
      last = { error: e instanceof Error ? e.message : String(e) };
    }
    if (Date.now() > end) assert.fail(`${what}: last ${JSON.stringify(last)}`);
    await sleep(500);
  }
};

// ---- a torrent of three files ---------------------------------------------

const bencode = (value: unknown): Buffer => {
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      Buffer.from('l'),
      ...value.map(bencode),
      Buffer.from('e'),
    ]);
  }
  const dict = value as Record<string, unknown>;
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(dict)
      .sort()
      .flatMap((key) => [bencode(key), bencode(dict[key])]),
    Buffer.from('e'),
  ]);
};

const PACK = 'Real Check Pack';
const PIECE = 256 * 1024;
const FILES = [
  { path: ['Real.Check.S01E01.mkv'], size: 3 * 1024 * 1024 + 123 },
  { path: ['Real.Check.S01E02.mkv'], size: 2 * 1024 * 1024 + 77 },
  // Skipped: its first bytes share the second episode's last piece.
  { path: ['Extras', 'Real.Check.Sample.mkv'], size: 1024 * 1024 + 5 },
];
const CONTENT = FILES.map((file) => randomBytes(file.size));
const ALL = Buffer.concat(CONTENT);
const INFO = {
  name: PACK,
  'piece length': PIECE,
  pieces: Buffer.concat(
    Array.from({ length: Math.ceil(ALL.length / PIECE) }, (_, i) =>
      createHash('sha1')
        .update(ALL.subarray(i * PIECE, (i + 1) * PIECE))
        .digest()
    )
  ),
  files: FILES.map((file) => ({ length: file.size, path: file.path })),
};
// A tracker nobody answers: rTorrent won't take a torrent with none.
const TRACKER = 'http://127.0.0.1:1/announce';
const TORRENT = bencode({ announce: TRACKER, info: INFO });
const HASH = createHash('sha1').update(bencode(INFO)).digest('hex');
const MAGNET_HASH = randomBytes(20).toString('hex');
const MAGNET = `magnet:?xt=urn:btih:${MAGNET_HASH}&dn=Real.Check.Magnet&tr=${encodeURIComponent(TRACKER)}`;
const CATEGORY = 'seerr-backfill-check';
const EPISODES = FILES[0].size + FILES[1].size;

/** The pack's files under `folder`; the skipped one only in part. */
const lay = (folder: string, sample: 'all' | 'shared' | 'none') => {
  FILES.forEach((file, i) => {
    const path = join(folder, PACK, ...file.path);
    mkdirSync(join(path, '..'), { recursive: true });
    if (i < 2) writeFileSync(path, CONTENT[i]);
    else if (sample === 'all') writeFileSync(path, CONTENT[i]);
    else if (sample === 'shared') {
      const shared = Math.ceil(EPISODES / PIECE) * PIECE - EPISODES;
      writeFileSync(path, CONTENT[i].subarray(0, shared));
    }
  });
};

// ---- a news server with one post -----------------------------------------

const POSTED = 'real-check-e04@example.invalid';
const MISSING = 'real-check-gone@example.invalid';
const POSTED_FILE = 'Real.Check.S01E04.mkv';
const POSTED_DATA = randomBytes(400_000);

const yenc = (data: Buffer, name: string): Buffer => {
  const lines: Buffer[] = [];
  let line: number[] = [];
  for (const byte of data) {
    const c = (byte + 42) % 256;
    if (
      [0, 10, 13, 61].includes(c) ||
      (line.length === 0 && [9, 32, 46].includes(c))
    ) {
      line.push(61, (c + 64) % 256);
    } else {
      line.push(c);
    }
    if (line.length >= 128) {
      lines.push(Buffer.from(line));
      line = [];
    }
  }
  if (line.length) lines.push(Buffer.from(line));
  const crc = (crc32(data) >>> 0).toString(16).padStart(8, '0');
  return Buffer.concat([
    Buffer.from(`=ybegin line=128 size=${data.length} name=${name}\r\n`),
    Buffer.concat(lines.flatMap((l) => [l, Buffer.from('\r\n')])),
    Buffer.from(`=yend size=${data.length} crc32=${crc}\r\n`),
  ]);
};

const newsServer = () =>
  net.createServer((socket) => {
    const body = yenc(POSTED_DATA, POSTED_FILE);
    const head = Buffer.from(
      `From: real@check\r\nNewsgroups: alt.binaries.test\r\nSubject: "${POSTED_FILE}" yEnc (1/1)\r\nMessage-ID: <${POSTED}>\r\n`
    );
    const send = (text: string) => socket.write(`${text}\r\n`);
    const block = (data: Buffer) => {
      for (const line of data
        .toString('latin1')
        .replace(/\r\n$/, '')
        .split('\r\n')) {
        socket.write(
          Buffer.from(`${line.startsWith('.') ? '.' : ''}${line}\r\n`, 'latin1')
        );
      }
      socket.write('.\r\n');
    };
    send('200 real-check ready');
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk.toString('latin1');
      let end: number;
      while ((end = pending.indexOf('\r\n')) >= 0) {
        const command = pending.slice(0, end).trim();
        pending = pending.slice(end + 2);
        const [word, ...rest] = command.split(' ');
        const arg = rest.join(' ');
        const id = arg.replace(/^<|>$/g, '');
        switch (word.toUpperCase()) {
          case 'QUIT':
            send('205 bye');
            socket.end();
            return;
          case 'CAPABILITIES':
            send('101 capabilities');
            socket.write('VERSION 2\r\nREADER\r\n.\r\n');
            break;
          case 'MODE':
            send('200 reader');
            break;
          case 'AUTHINFO':
            send(/^pass/i.test(arg) ? '281 ok' : '381 more');
            break;
          case 'DATE':
            send('111 20260101000000');
            break;
          case 'GROUP':
            send(`211 1 1 1 ${arg}`);
            break;
          case 'ARTICLE':
          case 'BODY':
          case 'HEAD':
          case 'STAT': {
            if (id !== POSTED) {
              send('430 no such article');
              break;
            }
            const kind = word.toUpperCase();
            send(
              `${{ ARTICLE: 220, HEAD: 221, BODY: 222, STAT: 223 }[kind]} 0 <${id}>`
            );
            if (kind === 'ARTICLE')
              block(Buffer.concat([head, Buffer.from('\r\n'), body]));
            if (kind === 'BODY') block(body);
            if (kind === 'HEAD') block(head);
            break;
          }
          default:
            send('500 unknown');
        }
      }
    });
    socket.on('error', () => undefined);
  });

const NEWS_PORT = Number(env('NEWS_PORT', '1119'));
const NEWS_HOST = env('NEWS_HOST', '127.0.0.1');

const nzbOf = (messageId: string, fileName: string) =>
  Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
<file poster="real@check" date="1700000000" subject="[1/1] - &quot;${fileName}&quot; yEnc (1/1)">
<groups><group>alt.binaries.test</group></groups>
<segments><segment bytes="550000" number="1">${messageId}</segment></segments>
</file>
</nzb>`);

// ---- the clients -----------------------------------------------------------

const deluge = (password?: string) =>
  new DelugeAPI({
    ...where('DELUGE', 8112),
    // A wrong password is tried at another address, so the session the
    // right one has is not reused.
    ...(password ? { hostname: 'localhost' } : {}),
    password: password ?? env('DELUGE_PASS', 'deluge'),
  });
/** Each torrent client, signed in with `password` when given. */
const torrentClients: [string, (password?: string) => TorrentClient][] = [
  ['Deluge', deluge],
  [
    'qBittorrent',
    (password) =>
      new QBittorrentAPI({
        ...where('QBITTORRENT', 8090),
        ...(password ? { hostname: 'localhost' } : {}),
        username: env('QBITTORRENT_USER', 'admin'),
        password: password ?? env('QBITTORRENT_PASS', 'adminadmin'),
      }),
  ],
  [
    'Transmission',
    (password) =>
      new TransmissionAPI({
        ...where('TRANSMISSION', 9091),
        username: env('TRANSMISSION_USER', 'transuser'),
        password: password ?? env('TRANSMISSION_PASS', 'transpass'),
      }),
  ],
  [
    'rTorrent',
    (password) =>
      new RtorrentAPI({
        ...where('RTORRENT', 8081),
        username: env('RTORRENT_USER', 'rtuser'),
        password: password ?? env('RTORRENT_PASS', 'rtpass'),
      }),
  ],
];
const nzbgetAt = () => ({
  ...where('NZBGET', 6789),
  username: env('NZBGET_USER', 'nzbuser'),
  password: env('NZBGET_PASS', 'nzbpass'),
});
const sabnzbdAt = () => ({
  ...where('SABNZBD', 8080),
  apiKey: env('SABNZBD_KEY', ''),
});
const usenetClients: [string, () => UsenetClient][] = [
  ['NZBGet', () => new NzbgetAPI(nzbgetAt())],
  ['SABnzbd', () => new SabnzbdAPI(sabnzbdAt())],
];

/** Points a Usenet client at the news server here, through its own API. */
const useNewsServer: Record<string, () => Promise<void>> = {
  NZBGet: async () => {
    const at = nzbgetAt();
    const rpc = async (method: string, params: unknown[]) =>
      (
        await axios.post(
          `http://${at.hostname}:${at.port}/jsonrpc`,
          { method, params },
          { auth: { username: at.username, password: at.password } }
        )
      ).data.result;
    const options: { Name: string; Value: string }[] = await rpc('config', []);
    const set: Record<string, string> = {
      'Server1.Active': 'yes',
      'Server1.Name': 'real-check',
      'Server1.Host': NEWS_HOST,
      'Server1.Port': String(NEWS_PORT),
      'Server1.Encryption': 'no',
      'Server1.Connections': '2',
      'Server1.Username': '',
      'Server1.Password': '',
      // Twice the same post in one run is no duplicate here.
      DupeCheck: 'no',
    };
    const others = options.filter(
      (o) => !(o.Name in set) && !/^Server[2-9]\./.test(o.Name)
    );
    await rpc('saveconfig', [
      [
        ...others,
        ...Object.entries(set).map(([Name, Value]) => ({ Name, Value })),
      ],
    ]);
    await rpc('reload', []);
    await sleep(3000);
    await until(
      'NZBGet back',
      () => rpc('version', []),
      (v) => !!v
    );
  },
  SABnzbd: async () => {
    const at = sabnzbdAt();
    const api = (params: Record<string, string | number>) =>
      axios.get(`http://${at.hostname}:${at.port}/api`, {
        params: { ...params, apikey: at.apiKey, output: 'json' },
      });
    await api({
      mode: 'set_config',
      section: 'servers',
      keyword: 'real-check',
      host: NEWS_HOST,
      port: NEWS_PORT,
      connections: 2,
      ssl: 0,
      enable: 1,
    });
    await api({ mode: 'resume' });
  },
};

// ---- the checks ------------------------------------------------------------

describe('the real download clients', { skip }, () => {
  let news: net.Server | undefined;
  before(async () => {
    if (!on('nzbget') && !on('sabnzbd')) return;
    news = newsServer();
    await new Promise<void>((resolve) =>
      news!.listen(NEWS_PORT, '0.0.0.0', resolve)
    );
  });
  after(() => news?.close());

  for (const [name, make] of torrentClients) {
    describe(name, { skip: !on(name) }, () => {
      const api = make();
      let save = '';

      before(async () => {
        if (name === 'Deluge') {
          // Its Label plugin, which Backfill's category needs, as a set-up
          // Deluge has it.
          const at = where('DELUGE', 8112);
          const url = `http://${at.hostname}:${at.port}/json`;
          const login = await axios.post(url, {
            method: 'auth.login',
            params: [env('DELUGE_PASS', 'deluge')],
            id: 1,
          });
          const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(
            ';'
          )[0];
          await api.getVersion();
          await axios.post(
            url,
            { method: 'core.enable_plugin', params: ['Label'], id: 2 },
            { headers: { Cookie: cookie } }
          );
          await sleep(1000);
        }
        for (const hash of [HASH, MAGNET_HASH]) {
          await api.deleteTorrent(hash).catch(() => undefined);
        }
      });

      it('connects with its password, and not with a wrong one', async (t) => {
        const version = await api.getVersion();
        t.diagnostic(`${name} ${version}`);
        assert.ok(version && version !== 'unknown', version);
        await api.ensureCategory(CATEGORY);
        assert.deepEqual(await api.backfillProblems(), []);
        await assert.rejects(make('wrong').getVersion());
      });

      it('adds a .torrent stopped, chooses its files, starts, stops and deletes it', async () => {
        await api.addTorrent({ torrent: TORRENT, category: CATEGORY });
        const added = await until(
          'found',
          () => api.findTorrent(HASH),
          (t) => !!t
        );
        assert.equal(added!.hash, HASH);
        assert.equal(added!.name, PACK);
        save = added!.savePath;
        const files = await until(
          'its files',
          () => api.getFiles(HASH),
          (f) => f.length === 3
        );
        assert.deepEqual(
          files.map((f) => [
            f.index,
            posix.basename(f.name.replace(/\\/g, '/')),
            f.size,
          ]),
          FILES.map((f, i) => [i, f.path[f.path.length - 1], f.size])
        );
        await until(
          'stopped',
          () => api.findTorrent(HASH),
          (t) => t?.state === 'paused'
        );
        assert.ok(
          (await api.listCategory(CATEGORY)).some((t) => t.hash === HASH),
          'in its category'
        );
        await api.setFilePriority(HASH, [2], 0);
        await api.setFilePriority(HASH, [0, 1], 1);
        await api.startTorrent(HASH);
        await until(
          'started',
          () => api.findTorrent(HASH),
          (t) => !!t && ['downloading', 'queued', 'checking'].includes(t.state)
        );
        const live = (
          await api.getDownloads([HASH.toUpperCase(), 'not-ours'])
        ).get(HASH);
        assert.ok(live, 'followed');
        // The files chosen, in whole pieces, as the clients count them.
        assert.equal(live.size, Math.ceil(EPISODES / PIECE) * PIECE);
        await api.stopTorrent(HASH);
        await until(
          'stopped',
          () => api.findTorrent(HASH),
          (t) => t?.state === 'paused'
        );
        await api.deleteTorrent(HASH);
        await until(
          'deleted',
          () => api.findTorrent(HASH),
          (t) => !t
        );
      });

      it('finishes once the files chosen are in, though one is skipped', async () => {
        lay(local(name, save), 'shared');
        await api.addTorrent({ torrent: TORRENT, category: CATEGORY });
        await until(
          'its files',
          () => api.getFiles(HASH),
          (f) => f.length === 3
        );
        await api.setFilePriority(HASH, [2], 0);
        await api.startTorrent(HASH);
        const done = await until(
          'done',
          () => api.findTorrent(HASH),
          (t) => t?.state === 'done',
          60_000
        );
        assert.equal(done!.progress, 1);
        const live = (await api.getDownloads([HASH])).get(HASH);
        assert.equal(live?.sizeLeft, 0);
        assert.equal(live?.stage, 'importing');
        const files = await api.getFiles(HASH);
        assert.deepEqual([files[0].progress, files[1].progress], [1, 1]);
        await api.deleteTorrent(HASH);
        await until(
          'deleted',
          () => api.findTorrent(HASH),
          (t) => !t
        );
      });

      it('deletes what it downloaded with it', async () => {
        lay(local(name, save), 'all');
        await api.addTorrent({ torrent: TORRENT, category: CATEGORY });
        await until(
          'found',
          () => api.findTorrent(HASH),
          (t) => !!t
        );
        await api.startTorrent(HASH);
        await until(
          'done',
          () => api.findTorrent(HASH),
          (t) => t?.state === 'done',
          60_000
        );
        await api.deleteTorrent(HASH);
        await until(
          'deleted',
          () => api.findTorrent(HASH),
          (t) => !t
        );
        const first = join(local(name, save), PACK, ...FILES[0].path);
        await until(
          'its files gone',
          async () => existsSync(first),
          (there) => !there,
          15_000
        );
      });

      it('follows a magnet link while its file list comes', async () => {
        await api.addTorrent({
          magnet: MAGNET,
          category: CATEGORY,
          metadataOnly: true,
        });
        await until(
          'fetching its file list',
          () => api.findTorrent(MAGNET_HASH),
          (t) => t?.state === 'metadata'
        );
        assert.deepEqual(await api.getFiles(MAGNET_HASH), []);
        await api.deleteTorrent(MAGNET_HASH);
        await until(
          'deleted',
          () => api.findTorrent(MAGNET_HASH),
          (t) => !t
        );
      });
    });
  }

  for (const [name, make] of usenetClients) {
    describe(name, { skip: !on(name) }, () => {
      const api = make();
      before(() => useNewsServer[name]());

      it('connects with its password or key, and not with a wrong one', async (t) => {
        const version = await api.getVersion();
        t.diagnostic(`${name} ${version}`);
        assert.ok(version && version !== 'unknown', version);
        const wrong =
          name === 'NZBGet'
            ? new NzbgetAPI({ ...nzbgetAt(), password: 'wrong' })
            : new SabnzbdAPI({ ...sabnzbdAt(), apiKey: 'wrong' });
        await assert.rejects(wrong.getVersion());
      });

      it('pauses, resumes and finishes a job, and says where its files are', async () => {
        const id = await api.addNzb(
          nzbOf(POSTED, POSTED_FILE),
          'Real.Check.S01E04',
          'tv'
        );
        await api.pauseJob(id);
        const paused = await until(
          'paused',
          () => api.getJob(id),
          (j) => /^paused$/i.test(j?.status ?? ''),
          15_000
        );
        assert.equal(paused!.place, 'queue');
        assert.equal(
          (await api.getDownloads([id])).get(id.toLowerCase())?.stage,
          'paused'
        );
        await api.resumeJob(id);
        const done = await until(
          'finished',
          () => api.getJob(id),
          (j) =>
            j?.place === 'history' && /^(completed|failed)$/i.test(j.status),
          90_000
        );
        assert.match(done!.status, /^completed$/i, JSON.stringify(done));
        // A folder, or the one file (SABnzbd, for a single file); Sonarr's
        // and Radarr's manual import take either.
        const storage = local(name, done!.storage ?? '');
        const file = storage.endsWith(POSTED_FILE)
          ? storage
          : join(storage, POSTED_FILE);
        assert.deepEqual(readFileSync(file), POSTED_DATA);
        await api.deleteJob(id);
        await until(
          'deleted',
          () => api.getJob(id),
          (j) => !j,
          15_000
        );
      });

      it('says a job failed when its post is gone', async () => {
        const id = await api.addNzb(
          nzbOf(MISSING, 'Real.Check.S01E05.mkv'),
          'Real.Check.S01E05',
          'tv'
        );
        const done = await until(
          'finished',
          () => api.getJob(id),
          (j) =>
            j?.place === 'history' && /^(completed|failed)$/i.test(j.status),
          90_000
        );
        assert.match(done!.status, /^failed$/i, JSON.stringify(done));
        await api.deleteJob(id);
        await until(
          'deleted',
          () => api.getJob(id),
          (j) => !j,
          15_000
        );
      });
    });
  }
});
