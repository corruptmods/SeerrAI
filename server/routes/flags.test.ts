import flags from '@server/routes/flags';
import express from 'express';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

describe('/flags', () => {
  const app = express();
  app.use('/flags', flags);
  app.use(
    (
      err: { status?: number },
      _req: express.Request,
      res: express.Response,
      // Express tells an error handler by its four parameters.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).end();
    }
  );
  let base = '';
  let server: ReturnType<typeof app.listen>;

  before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('serves a flag as an image, to be kept a while', async () => {
    const response = await fetch(`${base}/flags/US.svg`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /image\/svg\+xml/);
    assert.match(
      response.headers.get('cache-control') ?? '',
      /max-age=2592000/
    );
    assert.match(await response.text(), /^<svg/);
  });

  it('serves the regional ones too', async () => {
    const response = await fetch(`${base}/flags/GB-SCT.svg`);
    assert.equal(response.status, 200);
  });

  it('serves nothing else from the package', async () => {
    for (const name of [
      'flags.css',
      'flags.zip',
      'ZZ.svg',
      '../package.json',
    ]) {
      const response = await fetch(`${base}/flags/${name}`);
      assert.equal(response.status, 404, name);
    }
  });
});
