import TransmissionAPI from '@server/api/downloadclients/transmission';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * Transmission's two RPC formats, against a stand-in that answers as 4.0
 * (the older format only), 4.1 (JSON-RPC 2.0 with snake_case, and the older
 * format still) or a later version that has dropped the older format.
 *
 * The names on each side are written out here from Transmission's RPC
 * spec (4.0.6 for the older ones, main for 4.1), not worked out the way the
 * client does, so a wrong name on either side fails.
 */

const HASH = 'aa'.repeat(20);

/** Older-format name, 4.1 name. */
const NAMES: [string, string][] = [
  ['session-get', 'session_get'],
  ['torrent-get', 'torrent_get'],
  ['torrent-add', 'torrent_add'],
  ['torrent-set', 'torrent_set'],
  ['torrent-start', 'torrent_start'],
  ['torrent-stop', 'torrent_stop'],
  ['torrent-remove', 'torrent_remove'],
  ['version', 'version'],
  ['rpc-version', 'rpc_version'],
  ['fields', 'fields'],
  ['ids', 'ids'],
  ['torrents', 'torrents'],
  ['id', 'id'],
  ['hashString', 'hash_string'],
  ['name', 'name'],
  ['status', 'status'],
  ['error', 'error'],
  ['errorString', 'error_string'],
  ['percentDone', 'percent_done'],
  ['rateDownload', 'rate_download'],
  ['eta', 'eta'],
  ['downloadDir', 'download_dir'],
  ['addedDate', 'added_date'],
  ['sizeWhenDone', 'size_when_done'],
  ['leftUntilDone', 'left_until_done'],
  ['desiredAvailable', 'desired_available'],
  ['webseedsSendingToUs', 'webseeds_sending_to_us'],
  ['peersSendingToUs', 'peers_sending_to_us'],
  ['metadataPercentComplete', 'metadata_percent_complete'],
  ['labels', 'labels'],
  ['files', 'files'],
  ['length', 'length'],
  ['bytesCompleted', 'bytes_completed'],
  ['metainfo', 'metainfo'],
  ['filename', 'filename'],
  ['paused', 'paused'],
  ['torrent-added', 'torrent_added'],
  ['torrent-duplicate', 'torrent_duplicate'],
  ['seedRatioMode', 'seed_ratio_mode'],
  ['seedRatioLimit', 'seed_ratio_limit'],
  ['downloadLimited', 'download_limited'],
  ['downloadLimit', 'download_limit'],
  ['files-wanted', 'files_wanted'],
  ['files-unwanted', 'files_unwanted'],
  ['delete-local-data', 'delete_local_data'],
];
const TO_NEW = new Map(NAMES);
const TO_OLD = new Map(NAMES.map(([old, now]) => [now, old]));

type Version = '4.0' | '4.1' | 'later';
type Torrent = Record<string, unknown> & { hash_string: string };

const rename = (map: Map<string, string>, name: string) => {
  const renamed = map.get(name);
  if (!renamed) throw new Error(`unknown name ${name}`);
  return renamed;
};

/** Renames an object's keys, and the keys of objects inside it. */
const renameKeys = (map: Map<string, string>, value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((v) => renameKeys(map, v));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [rename(map, k), renameKeys(map, v)])
  );
};

const newTorrent = (name: string): Torrent => ({
  id: 1,
  hash_string: HASH,
  name,
  status: 0,
  error: 0,
  error_string: '',
  percent_done: 0.5,
  rate_download: 2048,
  eta: 60,
  download_dir: '/downloads',
  added_date: 1_700_000_000,
  size_when_done: 1000,
  left_until_done: 500,
  desired_available: 500,
  webseeds_sending_to_us: 0,
  peers_sending_to_us: 2,
  metadata_percent_complete: 1,
  labels: [],
  files: [
    { name: `${name}/${name}.mkv`, length: 900, bytes_completed: 450 },
    { name: `${name}/sample.mkv`, length: 100, bytes_completed: 50 },
  ],
});

const stand = {
  version: '4.0' as Version,
  sessionId: 'session-1',
  torrents: [] as Torrent[],
  /** What each request looked like: its format and method as sent. */
  sent: [] as string[],
  /** The 4.1-named arguments of each request. */
  args: [] as [string, Record<string, unknown>][],
};

const answerTo = (
  method: string,
  params: Record<string, unknown>
): Record<string, unknown> => {
  const ids = params.ids as string[] | undefined;
  const chosen = stand.torrents.filter(
    (t) => !ids || ids.includes(t.hash_string)
  );
  const pick = (t: Torrent) =>
    Object.fromEntries(
      (params.fields as string[]).map((field) => [field, t[field]])
    );
  switch (method) {
    case 'session_get': {
      const session: Record<string, unknown> =
        stand.version === '4.0'
          ? { version: '4.0.6 (38c164933e)', rpc_version: 17 }
          : stand.version === '4.1'
            ? { version: '4.1.0 (ae226418eb)', rpc_version: 18 }
            : { version: '5.0.0 (0123456789)', rpc_version: 20 };
      return Object.fromEntries(
        (params.fields as string[]).map((f) => [f, session[f]])
      );
    }
    case 'torrent_get':
      return { torrents: chosen.map(pick) };
    case 'torrent_add': {
      const name = params.metainfo ? 'Glasswing' : 'Static Garden';
      const there = stand.torrents.find((t) => t.hash_string === HASH);
      if (there) {
        return {
          torrent_duplicate: { id: 1, name: there.name, hash_string: HASH },
        };
      }
      stand.torrents.push(newTorrent(name));
      return { torrent_added: { id: 1, name, hash_string: HASH } };
    }
    case 'torrent_set':
      for (const t of chosen) {
        Object.assign(t, params, { ids: undefined });
      }
      return {};
    case 'torrent_start':
      chosen.forEach((t) => (t.status = 4));
      return {};
    case 'torrent_stop':
      chosen.forEach((t) => (t.status = 0));
      return {};
    case 'torrent_remove':
      stand.torrents = stand.torrents.filter((t) => !chosen.includes(t));
      return {};
  }
  throw new Error(`unknown method ${method}`);
};

const handle = (raw: string, res: http.ServerResponse) => {
  const request = JSON.parse(raw);
  const json = 'jsonrpc' in request;
  stand.sent.push(`${json ? 'json' : 'old'} ${request.method}`);
  res.setHeader('Content-Type', 'application/json');
  const reply = (body: unknown) => res.end(JSON.stringify(body));

  if (json && stand.version === '4.0') {
    // 4.0 reads only `method`, and knows no snake_case one.
    return reply({ result: 'method name not recognized', arguments: {} });
  }
  if (!json && stand.version === 'later') {
    return reply({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid Request' },
      id: null,
    });
  }
  if (json) {
    assert.equal(request.jsonrpc, '2.0');
    assert.equal(typeof request.id, 'number');
    assert.equal(request.arguments, undefined);
    // Every name already in 4.1's form.
    rename(TO_OLD, request.method);
    for (const key of Object.keys(request.params)) rename(TO_OLD, key);
    for (const field of request.params.fields ?? []) rename(TO_OLD, field);
    stand.args.push([request.method, request.params]);
    if (request.method === 'torrent_add' && request.params.metainfo === '') {
      return reply({
        jsonrpc: '2.0',
        error: {
          code: 14,
          message: 'invalid or corrupt torrent',
          data: { error_string: 'invalid or corrupt torrent file' },
        },
        id: request.id,
      });
    }
    return reply({
      jsonrpc: '2.0',
      result: answerTo(request.method, request.params),
      id: request.id,
    });
  }
  // The older format: its own names in, its own names out.
  const method = rename(TO_NEW, request.method);
  const args = request.arguments ?? {};
  const params = renameKeys(TO_NEW, args) as Record<string, unknown>;
  if (Array.isArray(args.fields)) {
    params.fields = args.fields.map((f: string) => rename(TO_NEW, f));
  }
  stand.args.push([method, params]);
  return reply({
    result: 'success',
    arguments: renameKeys(TO_OLD, answerTo(method, params)),
  });
};

let server: http.Server;
let port = 0;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.headers['x-transmission-session-id'] !== stand.sessionId) {
        res.statusCode = 409;
        res.setHeader('X-Transmission-Session-Id', stand.sessionId);
        if (stand.version !== '4.0') {
          res.setHeader(
            'X-Transmission-Rpc-Version',
            stand.version === '4.1' ? '6.0.0' : '7.0.0'
          );
        }
        return res.end();
      }
      try {
        handle(raw, res);
      } catch (e) {
        res.statusCode = 500;
        res.end(String(e));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => server.close());

beforeEach(() => {
  stand.torrents = [];
  stand.sent = [];
  stand.args = [];
});

/** Each test its own address, so none reuses another's session or format. */
const client = (urlBase: string) =>
  new TransmissionAPI({
    hostname: '127.0.0.1',
    port,
    useSsl: false,
    urlBase,
    username: '',
    password: '',
  });

/** Everything the client does, in the order Backfill would. */
const everything = async (api: TransmissionAPI) => {
  const seen: Record<string, unknown> = {};
  seen.version = await api.getVersion();
  seen.problems = await api.backfillProblems();
  await api.addTorrent({
    torrent: Buffer.from('d4:infod4:name9:Glasswingee'),
    hash: HASH,
    category: 'backfill',
  });
  seen.found = await api.findTorrent(HASH.toUpperCase());
  seen.listed = (await api.listCategory('backfill')).map((t) => t.name);
  seen.files = await api.getFiles(HASH);
  await api.setFilePriority(HASH, [1], 0);
  await api.setFilePriority(HASH, [0], 1);
  await api.startTorrent(HASH);
  seen.live = Object.fromEntries(await api.getDownloads([HASH, 'sab-1']));
  await api.stopTorrent(HASH);
  seen.stopped = (await api.findTorrent(HASH))?.state;
  await api.deleteTorrent(HASH);
  seen.gone = await api.findTorrent(HASH);
  await api.addTorrent({
    magnet: `magnet:?xt=urn:btih:${HASH}`,
    hash: HASH,
    category: 'backfill',
    metadataOnly: true,
  });
  await assert.rejects(
    api.addTorrent({
      magnet: `magnet:?xt=urn:btih:${HASH}`,
      hash: HASH,
      category: 'backfill',
    }),
    /already in Transmission/
  );
  seen.magnet = stand.torrents[0];
  return seen;
};

describe('Transmission’s two RPC formats', () => {
  it('speaks the older format to 4.0, for everything it does', async () => {
    stand.version = '4.0';
    const seen = await everything(client('/four-oh'));
    assert.ok(stand.sent.every((s) => s.startsWith('old ')));
    assert.equal(seen.version, '4.0.6 (38c164933e)');
    assert.deepEqual(seen.problems, []);
    assert.deepEqual(seen.listed, ['Glasswing']);
    assert.equal(seen.stopped, 'paused');
    assert.equal(seen.gone, undefined);
  });

  it('speaks JSON-RPC to 4.1 and gets the same answers', async () => {
    stand.version = '4.0';
    const old = await everything(client('/same-old'));
    const oldArgs = stand.args.slice(1);

    stand.version = '4.1';
    stand.torrents = [];
    stand.sent = [];
    stand.args = [];
    const now = await everything(client('/same-new'));

    // Asked once in the format both understand, then JSON-RPC throughout.
    assert.equal(stand.sent[0], 'old session-get');
    assert.ok(stand.sent.slice(1).every((s) => s.startsWith('json ')));
    assert.ok(stand.sent.includes('json torrent_get'));
    assert.ok(stand.sent.includes('json torrent_set'));
    assert.ok(stand.sent.includes('json torrent_remove'));
    // The same requests, by their 4.1 names.
    assert.deepEqual(stand.args.slice(1), oldArgs);
    assert.deepEqual({ ...now, version: '' }, { ...old, version: '' });
    assert.equal(now.version, '4.1.0 (ae226418eb)');
  });

  it('sends the 4.1 names for what Backfill sets', async () => {
    stand.version = '4.1';
    await everything(client('/names'));
    const sets = stand.args
      .filter(([m]) => m === 'torrent_set')
      .map(([, a]) => a);
    assert.deepEqual(sets, [
      { ids: [HASH], seed_ratio_mode: 1, seed_ratio_limit: 0 },
      { ids: [HASH], labels: ['backfill'] },
      { ids: [HASH], files_unwanted: [1] },
      { ids: [HASH], files_wanted: [0] },
      { ids: [HASH], download_limited: false },
      {
        ids: [HASH],
        seed_ratio_mode: 1,
        seed_ratio_limit: 0,
        download_limited: true,
        download_limit: 1,
      },
      { ids: [HASH], labels: ['backfill'] },
    ]);
    assert.deepEqual(stand.args.find(([m]) => m === 'torrent_remove')?.[1], {
      ids: [HASH],
      delete_local_data: true,
    });
    assert.deepEqual(stand.args.find(([m]) => m === 'torrent_add')?.[1], {
      metainfo: Buffer.from('d4:infod4:name9:Glasswingee').toString('base64'),
      paused: true,
    });
  });

  it('finds the format once per client and keeps it', async () => {
    stand.version = '4.1';
    await client('/kept').getVersion();
    await client('/kept').findTorrent(HASH);
    await client('/kept').getVersion();
    assert.deepEqual(stand.sent, [
      'old session-get',
      'json torrent_get',
      'json session_get',
    ]);
  });

  it('switches to JSON-RPC when 4.0 is upgraded to 4.1', async () => {
    stand.version = '4.0';
    const api = client('/upgraded');
    await api.findTorrent(HASH);
    stand.version = '4.1';
    stand.sessionId = 'session-2'; // restarted
    stand.sent = [];
    await api.findTorrent(HASH);
    // The 409 says the version: resent as JSON-RPC, with no need to ask.
    assert.deepEqual(stand.sent, ['json torrent_get']);
    stand.sessionId = 'session-1';
  });

  it('goes back to the older format when JSON-RPC is refused', async () => {
    stand.version = '4.1';
    const api = client('/downgraded');
    await api.findTorrent(HASH);
    stand.version = '4.0'; // same session id: no 409 to say so
    stand.sent = [];
    assert.equal(await api.findTorrent(HASH), undefined);
    assert.deepEqual(stand.sent, [
      'json torrent_get',
      'old session-get',
      'old torrent-get',
    ]);
  });

  it('uses JSON-RPC alone with a version that dropped the older format', async () => {
    stand.version = 'later';
    const api = client('/later');
    assert.equal(await api.getVersion(), '5.0.0 (0123456789)');
    await api.findTorrent(HASH);
    assert.deepEqual(stand.sent, [
      'old session-get',
      'json session_get',
      'json torrent_get',
    ]);
  });

  it('reports a JSON-RPC error by what Transmission says', async () => {
    stand.version = '4.1';
    await assert.rejects(
      client('/error').addTorrent({
        torrent: Buffer.alloc(0),
        hash: HASH,
        category: 'backfill',
      }),
      /Transmission: invalid or corrupt torrent file/
    );
  });
});
