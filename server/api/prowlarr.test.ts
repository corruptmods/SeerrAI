import type { ProwlarrRelease } from '@server/api/prowlarr';
import ProwlarrAPI from '@server/api/prowlarr';
import assert from 'node:assert/strict';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

/*
 * Fetching a search result through Prowlarr, against a stand-in Prowlarr.
 * Most torrent indexers give no download link, only Prowlarr's own link
 * for the magnet (which redirects to it): the shapes here are what the
 * live Prowlarr answered for EZTV, Knaben and ExtraTorrent results.
 */

const MAGNET = 'magnet:?xt=urn:btih:7ea162cd6756dd883e69ce57085648ecd035dae3';
const TORRENT = Buffer.from('d4:infod4:name4:showee');

let server: Server;
let prowlarr: ProwlarrAPI;
let base = '';
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    if (req.url?.startsWith('/1/download?link=magnet')) {
      res.writeHead(301, { Location: MAGNET }).end();
    } else if (req.url?.startsWith('/2/download')) {
      res.writeHead(200).end(TORRENT);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  prowlarr = new ProwlarrAPI({
    hostname: '127.0.0.1',
    port,
    useSsl: false,
    urlBase: '',
    apiKey: 'prowlarr-key',
  });
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const release = (over: Partial<ProwlarrRelease>): ProwlarrRelease => ({
  guid: 'https://indexer/1',
  title: 'Expedition Unknown Season 5 Complete 720p WEB x264 [i_c]',
  size: 1,
  indexerId: 46,
  indexer: 'ExtraTorrent.st',
  protocol: 'torrent',
  ...over,
});

describe('Fetching a result through Prowlarr', () => {
  it('follows Prowlarr’s link to a magnet when there is no download link', async () => {
    const fetched = await prowlarr.fetchRelease(
      release({ magnetUrl: `${base}/1/download?link=magnet` })
    );
    assert.deepEqual(fetched, { kind: 'magnet', uri: MAGNET });
    assert.equal(seen.at(-1)?.headers['x-api-key'], 'prowlarr-key');
  });

  it('takes a bare magnet, or one in the guid, without fetching anything', async () => {
    const before = seen.length;
    assert.deepEqual(
      await prowlarr.fetchRelease(release({ magnetUrl: MAGNET })),
      { kind: 'magnet', uri: MAGNET }
    );
    assert.deepEqual(await prowlarr.fetchRelease(release({ guid: MAGNET })), {
      kind: 'magnet',
      uri: MAGNET,
    });
    assert.equal(seen.length, before);
  });

  it('makes a magnet from the hash as a last resort', async () => {
    const fetched = await prowlarr.fetchRelease(
      release({ infoHash: '7ea162cd6756dd883e69ce57085648ecd035dae3' })
    );
    assert.equal(fetched.kind, 'magnet');
    assert.match(
      (fetched as { uri: string }).uri,
      /^magnet:\?xt=urn:btih:7ea162cd6756dd883e69ce57085648ecd035dae3&dn=Expedition/
    );
  });

  it('downloads the .torrent when there is a download link', async () => {
    const fetched = await prowlarr.fetchRelease(
      release({
        downloadUrl: `${base}/2/download`,
        magnetUrl: `${base}/1/download?link=magnet`,
      })
    );
    assert.equal(fetched.kind, 'torrent');
  });

  it('says so when a result has no way to get it', async () => {
    await assert.rejects(
      prowlarr.fetchRelease(release({})),
      /no download link/
    );
  });
});
