import { downloadClientFor } from '@server/api/downloadclients';
import { MediaType } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import { withLiveProgress } from '@server/lib/downloadtracker';
import type { DownloadClientSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { downloadBadgeLabel } from './downloadSummary';

/*
 * The status pill for a download, from each download client Seerr AI reads:
 * a Sonarr queue item carrying the download id exactly as Sonarr records
 * it for that client, the client's own answer (from a stand-in speaking its
 * protocol), merged as the tracker merges them, and the pill's label.
 */

const MB = 1024 * 1024;
const NOW = Date.parse('2026-10-11T21:00:00Z');
// Sonarr records a torrent by its hash in capitals, an NZBGet job by the
// "drone" GUID it gave the NZB.
const HASH_A = 'AA'.repeat(20);
const HASH_B = 'BB'.repeat(20);
const HASH_C = 'CC'.repeat(20);
const DRONE_A = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const DRONE_B = '1f1e2d3c4b5a69788796a5b4c3d2e1f0';

const queued = (downloadId: string): DownloadingItem => ({
  mediaType: MediaType.TV,
  externalId: 1,
  size: 1000 * MB,
  sizeLeft: 1000 * MB,
  status: 'downloading',
  stage: 'downloading',
  timeLeft: '00:10:00',
  estimatedCompletionTime: new Date(NOW + 600_000),
  title: 'A series',
  downloadId,
});

const servers: http.Server[] = [];
const ports: Record<string, number> = {};

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

before(async () => {
  await listen('transmission', async (req, res) => {
    const { method } = JSON.parse(await body(req));
    if (req.headers['x-transmission-session-id'] !== 's') {
      res.statusCode = 409;
      res.setHeader('X-Transmission-Session-Id', 's');
      return res.end();
    }
    res.setHeader('Content-Type', 'application/json');
    if (method !== 'torrent-get') {
      return res.end(JSON.stringify({ result: 'success', arguments: {} }));
    }
    const t = (hashString: string, extra: object) => ({
      hashString: hashString.toLowerCase(),
      sizeWhenDone: 1000 * MB,
      leftUntilDone: 400 * MB,
      eta: 120,
      error: 0,
      peersSendingToUs: 3,
      ...extra,
    });
    res.end(
      JSON.stringify({
        result: 'success',
        arguments: {
          torrents: [
            t(HASH_A, { status: 4 }),
            t(HASH_B, { status: 4, peersSendingToUs: 0 }),
            t(HASH_C, { status: 6, leftUntilDone: 0 }),
          ],
        },
      })
    );
  });

  await listen('deluge', async (req, res) => {
    const { method, id } = JSON.parse(await body(req));
    res.setHeader('Content-Type', 'application/json');
    const answer = (result: unknown) =>
      res.end(JSON.stringify({ result, error: null, id }));
    if (method === 'auth.login') {
      res.setHeader('Set-Cookie', '_session_id=d');
      return answer(true);
    }
    if (method === 'web.connected') return answer(true);
    answer({
      [HASH_A.toLowerCase()]: {
        state: 'Checking',
        total_wanted: 1000 * MB,
        total_done: 1000 * MB,
        eta: 0,
        is_finished: true,
      },
      [HASH_B.toLowerCase()]: {
        state: 'Paused',
        total_wanted: 1000 * MB,
        total_done: 250 * MB,
        eta: 0,
      },
    });
  });

  await listen('nzbget', async (req, res) => {
    const { method } = JSON.parse(await body(req));
    res.setHeader('Content-Type', 'application/json');
    const job = (NZBID: number, drone: string, Status: string) => ({
      NZBID,
      Status,
      FileSizeMB: 1000,
      RemainingSizeMB: Status === 'DOWNLOADING' ? 300 : 0,
      Parameters: [{ Name: 'drone', Value: drone }],
    });
    const result =
      method === 'status'
        ? { DownloadRate: 10 * MB, DownloadPaused: false }
        : method === 'listgroups'
          ? [job(1, DRONE_A, 'DOWNLOADING'), job(2, DRONE_B, 'UNPACKING')]
          : [];
    res.end(JSON.stringify({ result, id: 1 }));
  });

  await listen('rtorrent', async (req, res) => {
    await body(req);
    res.setHeader('Content-Type', 'text/xml');
    const v = (inner: string) => `<value>${inner}</value>`;
    const row = (hash: string, fields: number[]) =>
      v(
        `<array><data>${[
          v(`<string>${hash}</string>`),
          ...fields.map((n) => v(`<i8>${n}</i8>`)),
        ].join('')}</data></array>`
      );
    // state, active, open, complete, size, left, rate, checking, peers
    res.end(
      `<methodResponse><params><param>${v(
        `<array><data>${row(HASH_A, [1, 1, 1, 0, 1000 * MB, 500 * MB, 5 * MB, 0, 4])}${row(
          HASH_B,
          [1, 1, 1, 0, 1000 * MB, 1000 * MB, 0, 1, 0]
        )}</data></array>`
      )}</param></params></methodResponse>`
    );
  });
});

after(() => servers.forEach((server) => server.close()));

const client = (
  type: DownloadClientSettings['type'],
  extra: Partial<DownloadClientSettings> = {}
): DownloadClientSettings => ({
  id: 1,
  name: type,
  type,
  hostname: '127.0.0.1',
  port: ports[type],
  useSsl: false,
  urlBase: '',
  apiKey: '',
  username: '',
  password: '',
  ...extra,
});

/** The pill for each download id, as the tracker builds it. */
const pills = async (settings: DownloadClientSettings, ids: string[]) => {
  const live = await downloadClientFor(settings).getDownloads(ids);
  return ids.map((id) => {
    const merged = withLiveProgress(
      queued(id),
      live.get(id.toLowerCase()),
      NOW
    );
    return {
      label: downloadBadgeLabel(merged),
      percent: Math.round((1 - merged.sizeLeft / merged.size) * 100),
      secondsLeft: merged.estimatedCompletionTime
        ? (merged.estimatedCompletionTime.getTime() - NOW) / 1000
        : undefined,
    };
  });
};

describe('status pills from each download client', () => {
  it('Transmission: downloading, stalled, and seeding while imported', async () => {
    assert.deepEqual(
      await pills(client('transmission'), [HASH_A, HASH_B, HASH_C]),
      [
        { label: 'downloading', percent: 60, secondsLeft: 120 },
        { label: 'stalled', percent: 60, secondsLeft: undefined },
        { label: 'importing', percent: 100, secondsLeft: undefined },
      ]
    );
  });

  it('Deluge: checked once complete, and paused part-way', async () => {
    assert.deepEqual(
      await pills(client('deluge', { password: 'x' }), [HASH_A, HASH_B]),
      [
        { label: 'checking', percent: 100, secondsLeft: undefined },
        { label: 'paused', percent: 25, secondsLeft: undefined },
      ]
    );
  });

  it('NZBGet: downloading with time left, then unpacking', async () => {
    assert.deepEqual(await pills(client('nzbget'), [DRONE_A, DRONE_B]), [
      { label: 'downloading', percent: 70, secondsLeft: 30 },
      { label: 'unpacking', percent: 100, secondsLeft: undefined },
    ]);
  });

  it('rTorrent: downloading with time left, and checked before it starts', async () => {
    assert.deepEqual(await pills(client('rtorrent'), [HASH_A, HASH_B]), [
      { label: 'downloading', percent: 50, secondsLeft: 100 },
      { label: 'checking', percent: 0, secondsLeft: undefined },
    ]);
  });

  it('a download its client does not hold keeps Sonarr’s own word', async () => {
    const [pill] = await pills(client('transmission'), ['DD'.repeat(20)]);
    assert.deepEqual(pill, {
      label: 'downloading',
      percent: 0,
      secondsLeft: 600,
    });
  });
});
