import DelugeAPI, { delugeDownload } from '@server/api/downloadclients/deluge';
import NzbgetAPI, {
  nzbgetHistoryDownload,
  nzbgetJobId,
  nzbgetQueueDownload,
} from '@server/api/downloadclients/nzbget';
import RtorrentAPI, {
  rtorrentDownload,
  xmlRpcCall,
  xmlRpcResult,
} from '@server/api/downloadclients/rtorrent';
import TransmissionAPI, {
  transmissionDownload,
  transmissionTorrent,
} from '@server/api/downloadclients/transmission';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

/*
 * Transmission, Deluge, NZBGet and rTorrent, read for live progress: how
 * each one's states read as a download's stage, and each talked to through
 * a stand-in that speaks its protocol as the real one does.
 */

const MB = 1024 * 1024;
const HASH = 'ab'.repeat(20);
const OTHER = 'cd'.repeat(20);
/** How Sonarr names an NZB it sends NZBGet: a GUID without dashes. */
const DRONE = '9f2c4e1ab7d34c0e8a5b6c7d8e9f0a1b';

describe('reading each client’s states', () => {
  it('Transmission', () => {
    const t = (status: number, extra = {}) =>
      transmissionDownload({
        hashString: HASH,
        status,
        sizeWhenDone: 100,
        leftUntilDone: 40,
        eta: 30,
        error: 0,
        peersSendingToUs: 2,
        ...extra,
      });
    assert.deepEqual(t(4), {
      size: 100,
      sizeLeft: 40,
      stage: 'downloading',
      secondsLeft: 30,
    });
    assert.deepEqual(
      [t(4, { peersSendingToUs: 0 }).stage, t(4, { peersSendingToUs: 0 }).step],
      ['stalled', 'noPeers']
    );
    assert.equal(t(0).stage, 'paused');
    assert.equal(t(0, { leftUntilDone: 0 }).stage, 'importing');
    assert.equal(t(6, { leftUntilDone: 0 }).stage, 'importing');
    assert.deepEqual([t(2).stage, t(2).step], ['queued', 'checking']);
    assert.equal(t(3).stage, 'queued');
    assert.equal(t(4, { metadataPercentComplete: 0.5 }).step, 'metadata');
    assert.equal(t(4, { error: 3 }).stage, 'stalled');
    assert.equal(t(4, { eta: -1 }).secondsLeft, undefined);
  });

  it('Transmission: what the swarm lacks of what is wanted', () => {
    const t = (extra = {}) =>
      transmissionTorrent({
        hashString: HASH,
        name: 'pack',
        status: 4,
        error: 0,
        percentDone: 0.4,
        rateDownload: 10,
        eta: 30,
        downloadDir: '/downloads',
        sizeWhenDone: 100,
        leftUntilDone: 60,
        ...extra,
      }).unavailable;
    assert.equal(t({ desiredAvailable: 45 }), 15);
    assert.equal(t({ desiredAvailable: 60 }), 0);
    assert.equal(t(), undefined);
    // Web seeds have it all, though they aren't peers.
    assert.equal(t({ desiredAvailable: 0, webseedsSendingToUs: 1 }), undefined);
  });

  it('Deluge', () => {
    const d = (state: string, extra = {}) =>
      delugeDownload({
        state,
        total_wanted: 100,
        total_done: 60,
        eta: 20,
        num_seeds: 3,
        ...extra,
      });
    assert.deepEqual(d('Downloading'), {
      size: 100,
      sizeLeft: 40,
      stage: 'downloading',
      secondsLeft: 20,
    });
    assert.equal(d('Downloading', { num_seeds: 0 }).step, 'noPeers');
    assert.equal(d('Seeding').stage, 'importing');
    assert.equal(d('Paused').stage, 'paused');
    assert.equal(d('Paused', { is_finished: true }).stage, 'importing');
    assert.equal(d('Queued').stage, 'queued');
    assert.deepEqual(
      [d('Moving').stage, d('Moving').step],
      ['finishing', 'moving']
    );
    assert.equal(d('Error').stage, 'stalled');
    assert.equal(d('Downloading', { eta: 0 }).secondsLeft, undefined);
  });

  it('NZBGet', () => {
    const status = { DownloadRate: 10 * MB, DownloadPaused: false };
    const g = (Status: string) => ({
      NZBID: 7,
      Status,
      FileSizeMB: 1000,
      RemainingSizeMB: 200,
    });
    assert.deepEqual(nzbgetQueueDownload(g('DOWNLOADING'), status, true), {
      size: 1000 * MB,
      sizeLeft: 200 * MB,
      stage: 'downloading',
      secondsLeft: 20,
    });
    // Several downloading share one speed: no time can be given to one.
    assert.equal(
      nzbgetQueueDownload(g('DOWNLOADING'), status, false).secondsLeft,
      undefined
    );
    assert.equal(
      nzbgetQueueDownload(
        g('DOWNLOADING'),
        { ...status, DownloadPaused: true },
        true
      ).stage,
      'paused'
    );
    const step = (s: string) => {
      const live = nzbgetQueueDownload(g(s), status, true);
      return [live.stage, live.step];
    };
    assert.deepEqual(step('QUEUED'), ['queued', undefined]);
    assert.deepEqual(step('VERIFYING_SOURCES'), ['finishing', 'verifying']);
    assert.deepEqual(step('REPAIRING'), ['finishing', 'repairing']);
    assert.deepEqual(step('UNPACKING'), ['finishing', 'unpacking']);
    assert.deepEqual(step('MOVING'), ['finishing', 'moving']);
    assert.deepEqual(step('EXECUTING_SCRIPT'), ['finishing', 'script']);
    assert.deepEqual(step('PP_FINISHED'), ['importing', undefined]);

    const h = (Status: string) =>
      nzbgetHistoryDownload({ NZBID: 7, Status, FileSizeMB: 10 }).stage;
    assert.equal(h('SUCCESS/ALL'), 'importing');
    assert.equal(h('FAILURE/PAR'), 'failed');
    assert.equal(h('WARNING/SCRIPT'), 'needsAttention');
    assert.equal(h('DELETED/MANUAL'), 'failed');
  });

  it('NZBGet jobs are known by the id Sonarr recorded', () => {
    assert.equal(
      nzbgetJobId({
        NZBID: 7,
        Parameters: [{ Name: 'drone', Value: DRONE.toUpperCase() }],
      }),
      DRONE
    );
    assert.equal(nzbgetJobId({ NZBID: 7 }), '7');
  });

  it('rTorrent', () => {
    const r = (extra = {}) =>
      rtorrentDownload({
        hash: HASH,
        state: 1,
        isActive: 1,
        isOpen: 1,
        complete: 0,
        sizeBytes: 100,
        leftBytes: 50,
        downRate: 10,
        isHashChecking: 0,
        peersConnected: 4,
        chunkSize: 10,
        wantedChunks: 5,
        ...extra,
      });
    assert.deepEqual(r(), {
      size: 100,
      sizeLeft: 50,
      stage: 'downloading',
      secondsLeft: 5,
    });
    assert.equal(r({ complete: 1, leftBytes: 0 }).stage, 'importing');
    // A file skipped: rTorrent counts it as left, and never as complete,
    // as a real rTorrent 0.9.8 does. The files wanted are in.
    assert.deepEqual(r({ leftBytes: 30, wantedChunks: 0 }), {
      size: 70,
      sizeLeft: 0,
      stage: 'importing',
    });
    // Still downloading the files wanted: what's left of them only.
    assert.deepEqual(r({ leftBytes: 60, wantedChunks: 2 }), {
      size: 60,
      sizeLeft: 20,
      stage: 'downloading',
      secondsLeft: 2,
    });
    assert.equal(r({ isActive: 0 }).stage, 'paused');
    assert.equal(r({ state: 0 }).stage, 'paused');
    assert.equal(r({ peersConnected: 0 }).step, 'noPeers');
    assert.deepEqual(
      [r({ isHashChecking: 1 }).stage, r({ isHashChecking: 1 }).step],
      ['queued', 'checking']
    );
  });

  it('rTorrent’s XML-RPC, both ways', async () => {
    assert.equal(
      xmlRpcCall('d.multicall2', ['', 'main', 'd.hash=']),
      '<?xml version="1.0"?><methodCall><methodName>d.multicall2</methodName><params><param><value><string></string></value></param><param><value><string>main</string></value></param><param><value><string>d.hash=</string></value></param></params></methodCall>'
    );
    assert.deepEqual(
      await xmlRpcResult(
        '<?xml version="1.0"?><methodResponse><params><param><value><array><data>' +
          '<value><array><data><value><string>AB</string></value><value><i8>5</i8></value><value>plain</value></data></array></value>' +
          '</data></array></value></param></params></methodResponse>'
      ),
      [['AB', 5, 'plain']]
    );
    await assert.rejects(
      xmlRpcResult(
        '<methodResponse><fault><value><struct><member><name>faultCode</name><value><i4>-506</i4></value></member>' +
          '<member><name>faultString</name><value><string>Method not defined</string></value></member></struct></value></fault></methodResponse>'
      ),
      /rTorrent: Method not defined/
    );
  });
});

describe('talking to them', () => {
  const servers: http.Server[] = [];
  const ports: Record<string, number> = {};
  const calls: string[] = [];

  const body = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => resolve(raw));
    });

  const listen = (name: string, handler: http.RequestListener) =>
    new Promise<void>((resolve) => {
      const server = http.createServer(handler).listen(0, () => {
        ports[name] = (server.address() as AddressInfo).port;
        resolve();
      });
      servers.push(server);
    });

  const basic = (req: http.IncomingMessage) =>
    Buffer.from(
      String(req.headers.authorization ?? '').replace(/^Basic /, ''),
      'base64'
    ).toString();

  before(async () => {
    // Transmission: 409 with a session id first; that id is then required.
    await listen('transmission', async (req, res) => {
      const { method, arguments: args } = JSON.parse(await body(req));
      calls.push(`transmission ${method}`);
      if (basic(req) !== 'admin:secret') {
        res.statusCode = 401;
        return res.end();
      }
      if (req.headers['x-transmission-session-id'] !== 'session-1') {
        res.statusCode = 409;
        res.setHeader('X-Transmission-Session-Id', 'session-1');
        return res.end();
      }
      res.setHeader('Content-Type', 'application/json');
      if (method === 'session-get') {
        return res.end(
          JSON.stringify({ result: 'success', arguments: { version: '4.0.6' } })
        );
      }
      res.end(
        JSON.stringify({
          result: 'success',
          arguments: {
            torrents: (args.ids as string[])
              .filter((id) => id === HASH)
              .map(() => ({
                hashString: HASH,
                status: 4,
                sizeWhenDone: 100,
                leftUntilDone: 25,
                eta: 12,
                error: 0,
                peersSendingToUs: 1,
              })),
          },
        })
      );
    });

    // Deluge: signs in with its password, and is not yet connected to its
    // daemon, as after a restart. Deluge 2 lists daemon.get_version and no
    // daemon.info, as a 2.x Web UI answered system.listMethods; Deluge 1.3
    // (on its own port) the other way round.
    let delugeConnected = false;
    await listen('deluge', async (req, res) => {
      const { method, params, id } = JSON.parse(await body(req));
      calls.push(`deluge ${method}`);
      res.setHeader('Content-Type', 'application/json');
      const answer = (result: unknown, error: unknown = null) =>
        res.end(JSON.stringify({ result, error, id }));
      if (method === 'auth.login') {
        if (params[0] !== 'deluge-pass') return answer(false);
        res.setHeader('Set-Cookie', '_session_id=abc; Path=/json');
        return answer(true);
      }
      if (req.headers.cookie !== '_session_id=abc') {
        return answer(null, { message: 'Not authenticated', code: 1 });
      }
      if (method === 'web.connected') return answer(delugeConnected);
      if (method === 'web.get_hosts')
        return answer([['host-1', '127.0.0.1', 58846, 'Online']]);
      if (method === 'web.connect') {
        delugeConnected = params[0] === 'host-1';
        return answer([]);
      }
      if (!delugeConnected)
        return answer(null, { message: 'Not connected', code: 2 });
      if (method === 'daemon.get_version' && req.url !== '/old/json') {
        return answer('2.1.1');
      }
      if (method === 'daemon.info' && req.url === '/old/json') {
        return answer('1.3.15');
      }
      if (method === 'core.get_torrents_status') {
        return answer({
          [HASH]: {
            state: 'Seeding',
            total_wanted: 100,
            total_done: 100,
            eta: 0,
          },
        });
      }
      answer(null, { message: 'Unknown method', code: 2 });
    });

    // NZBGet: basic auth; one job in the queue with Sonarr's drone id, one
    // finished in the history known only by its NZBID.
    await listen('nzbget', async (req, res) => {
      const { method } = JSON.parse(await body(req));
      calls.push(`nzbget ${method}`);
      if (basic(req) !== 'nzbget:tegbzn6789') {
        res.statusCode = 401;
        return res.end();
      }
      res.setHeader('Content-Type', 'application/json');
      const result =
        method === 'version'
          ? '24.3'
          : method === 'status'
            ? { DownloadRate: 5 * MB, DownloadPaused: false }
            : method === 'listgroups'
              ? [
                  {
                    NZBID: 11,
                    Status: 'DOWNLOADING',
                    FileSizeMB: 100,
                    RemainingSizeMB: 50,
                    Parameters: [{ Name: 'drone', Value: DRONE }],
                  },
                ]
              : [{ NZBID: 12, Status: 'SUCCESS/ALL', FileSizeMB: 20 }];
      res.end(JSON.stringify({ result, id: 1 }));
    });

    // rTorrent behind ruTorrent's RPC2, with basic auth.
    await listen('rtorrent', async (req, res) => {
      const xml = await body(req);
      calls.push(`rtorrent ${req.url}`);
      if (basic(req) !== 'rt:pw') {
        res.statusCode = 401;
        return res.end();
      }
      res.setHeader('Content-Type', 'text/xml');
      const value = (v: string) => `<value>${v}</value>`;
      if (xml.includes('system.client_version')) {
        return res.end(
          `<methodResponse><params><param>${value('<string>0.9.8</string>')}</param></params></methodResponse>`
        );
      }
      const row = (hash: string, left: number) =>
        value(
          `<array><data>${[
            `<string>${hash.toUpperCase()}</string>`,
            '<i8>1</i8>',
            '<i8>1</i8>',
            '<i8>1</i8>',
            '<i8>0</i8>',
            '<i8>1000</i8>',
            `<i8>${left}</i8>`,
            '<i8>100</i8>',
            '<i8>0</i8>',
            '<i8>3</i8>',
          ]
            .map(value)
            .join('')}</data></array>`
        );
      res.end(
        `<methodResponse><params><param>${value(
          `<array><data>${row(HASH, 500)}${row(OTHER, 0)}</data></array>`
        )}</param></params></methodResponse>`
      );
    });
  });

  after(() => servers.forEach((server) => server.close()));

  const at = (name: string, extra: Record<string, string> = {}) => ({
    hostname: '127.0.0.1',
    port: ports[name],
    useSsl: false,
    urlBase: '',
    username: '',
    password: '',
    ...extra,
  });

  it('Transmission: gets a session id once, then reads only the torrents asked for', async () => {
    const api = new TransmissionAPI(
      at('transmission', { username: 'admin', password: 'secret' })
    );
    assert.equal(await api.getVersion(), '4.0.6');
    const found = await api.getDownloads([HASH.toUpperCase(), 'sab-job-1']);
    assert.deepEqual([...found.keys()], [HASH]);
    assert.equal(found.get(HASH)?.secondsLeft, 12);
    // One 409 handshake, then straight through.
    assert.deepEqual(
      calls.filter((c) => c.startsWith('transmission')),
      [
        'transmission session-get',
        'transmission session-get',
        'transmission torrent-get',
      ]
    );
  });

  it('Transmission: says so when the sign-in is wrong', async () => {
    const api = new TransmissionAPI(
      at('transmission', { username: 'admin', password: 'nope' })
    );
    await assert.rejects(api.getVersion(), /did not accept the username/);
  });

  it('Deluge: signs in, connects its Web UI to the daemon, and reads', async () => {
    const api = new DelugeAPI(at('deluge', { password: 'deluge-pass' }));
    assert.equal(await api.getVersion(), '2.1.1');
    const found = await api.getDownloads([HASH, OTHER]);
    assert.equal(found.get(HASH)?.stage, 'importing');
    assert.equal(found.has(OTHER), false);
    assert.ok(calls.includes('deluge web.connect'));
  });

  it('Deluge: reads the version of a 1.3 daemon, which has no daemon.get_version', async () => {
    const api = new DelugeAPI(
      at('deluge', { password: 'deluge-pass', urlBase: '/old' })
    );
    assert.equal(await api.getVersion(), '1.3.15');
  });

  it('Deluge: says so when the password is wrong', async () => {
    const api = new DelugeAPI({
      ...at('deluge', { password: 'wrong' }),
      // A different address, so the session above is not reused.
      hostname: 'localhost',
    });
    await assert.rejects(
      api.getVersion(),
      /Deluge did not accept the password/
    );
  });

  it('NZBGet: matches jobs by Sonarr’s id or the NZBID', async () => {
    const api = new NzbgetAPI(
      at('nzbget', { username: 'nzbget', password: 'tegbzn6789' })
    );
    assert.equal(await api.getVersion(), '24.3');
    const found = await api.getDownloads([DRONE.toUpperCase(), '12', HASH]);
    assert.deepEqual(found.get(DRONE), {
      size: 100 * MB,
      sizeLeft: 50 * MB,
      stage: 'downloading',
      secondsLeft: 10,
    });
    assert.equal(found.get('12')?.stage, 'importing');
    assert.equal(found.has(HASH), false);
    await assert.rejects(
      new NzbgetAPI(
        at('nzbget', { username: 'nzbget', password: 'x' })
      ).getVersion(),
      /NZBGet did not accept/
    );
  });

  it('rTorrent: reads its view through RPC2 and keeps only the torrents asked for', async () => {
    const api = new RtorrentAPI(
      at('rtorrent', { username: 'rt', password: 'pw' })
    );
    assert.equal(await api.getVersion(), '0.9.8');
    const found = await api.getDownloads([HASH]);
    assert.deepEqual(found.get(HASH), {
      size: 1000,
      sizeLeft: 500,
      stage: 'downloading',
      secondsLeft: 5,
    });
    assert.equal(found.size, 1);
    assert.ok(calls.includes('rtorrent /RPC2'));
  });
});
