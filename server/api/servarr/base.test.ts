import LidarrAPI from '@server/api/servarr/lidarr';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

/*
 * The API key goes to Sonarr, Radarr and Lidarr in the X-Api-Key header,
 * never in the address, and isn't kept on a failed request's error.
 */

const KEY = 'harbour-lights-key';
const seen: { url: string; key?: string }[] = [];
let server: http.Server;
let base = '';

before(async () => {
  server = http.createServer((req, res) => {
    seen.push({
      url: req.url ?? '',
      key: req.headers['x-api-key'] as string | undefined,
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-api-key'] !== KEY) {
      res.statusCode = 401;
      return res.end('{}');
    }
    if (req.url?.endsWith('/rootfolder')) {
      res.statusCode = 500;
      return res.end('{}');
    }
    res.end(JSON.stringify({ version: '5.0.0' }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

describe('the Servarr API key', () => {
  it('is sent as X-Api-Key to Sonarr, Radarr and Lidarr, not in the query', async () => {
    seen.length = 0;
    for (const api of [
      new SonarrAPI({ url: `${base}/api/v3`, apiKey: KEY }),
      new RadarrAPI({ url: `${base}/api/v3`, apiKey: KEY }),
      new LidarrAPI({ url: `${base}/api/v1`, apiKey: KEY }),
    ]) {
      assert.equal((await api.getSystemStatus()).version, '5.0.0');
    }
    assert.deepEqual(
      seen.map((s) => s.key),
      [KEY, KEY, KEY]
    );
    assert.ok(
      seen.every((s) => !s.url.includes('apikey')),
      String(seen)
    );
  });

  it('is hidden on a failed request', async () => {
    const radarr = new RadarrAPI({ url: `${base}/api/v3`, apiKey: KEY });
    const failed = await radarr.getRootFolderSpace().then(
      () => undefined,
      (e: unknown) => e
    );
    assert.ok(failed instanceof Error);
    assert.ok(!JSON.stringify(failed).includes(KEY));
    assert.ok(
      !JSON.stringify(
        (failed as { toJSON?: () => unknown }).toJSON?.()
      ).includes(KEY)
    );
  });
});
