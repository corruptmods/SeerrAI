import { musicImageProxy, tmdbImageProxy } from '@server/lib/imageproxy';
import imageproxy, { useSessionForImages } from '@server/routes/imageproxy';
import axios from 'axios';
import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { promises } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';

/*
 * The image route as a browser meets it: who may add to the cache, what a
 * response says about the image, and what a bad path gets.
 */

const unique = `${process.pid}-${Date.now()}`;
const poster = (name: string) => `/t/p/w300_and_h450_face/${unique}${name}.jpg`;
let upstream: string[] = [];
let base = '';
/** A real backdrop, for the paths named "real", which can be converted. */
let realJpeg: Buffer;
let server: ReturnType<express.Express['listen']>;
const SECRET = 'test-secret';
/** The cookie a browser holding that session sends. */
const cookieFor = (sid: string) => {
  // Signed as express-session signs it (cookie-signature).
  const signature = createHmac('sha256', SECRET)
    .update(sid)
    .digest('base64')
    .replace(/=+$/, '');
  return `connect.sid=${encodeURIComponent(`s:${sid}.${signature}`)}`;
};
const SIGNED_IN = { cookie: cookieFor('signed-in') };

before(async () => {
  realJpeg = await sharp({
    create: { width: 1920, height: 800, channels: 3, background: '#3a6ea5' },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg width="1920" height="800"><circle cx="960" cy="400" r="300" fill="#e0c050"/></svg>'
        ),
      },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
  // The upstream, standing in for image.tmdb.org.
  Object.defineProperty(tmdbImageProxy(), 'axios', {
    configurable: true,
    value: {
      get: async (path: string) => {
        upstream.push(path);
        if (path.includes('gone')) {
          throw Object.assign(new Error('status 404'), {
            response: { status: 404 },
          });
        }
        return {
          data: path.includes('real')
            ? realJpeg
            : Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
          headers: {
            'content-type': 'image/jpeg',
            'cache-control': 'max-age=31536000, public',
            ...(path.includes('noetag') ? {} : { etag: '"poster1"' }),
          },
        };
      },
    },
  });
  // Sessions as the app keeps them: a signed cookie naming a stored session.
  const store = new session.MemoryStore();
  await new Promise<void>((resolve) =>
    store.set('signed-in', { cookie: {}, userId: 1 } as never, () => resolve())
  );
  await new Promise<void>((resolve) =>
    store.set('signed-out', { cookie: {} } as never, () => resolve())
  );
  useSessionForImages({ store, secret: SECRET });

  const app = express();
  app.use(cookieParser());
  app.use('/imageproxy', imageproxy);
  app.use(
    (
      err: { status?: number },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).end();
    }
  );
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/imageproxy/tmdb`;
});

after(async () => {
  server.close();
  for (const source of ['tmdb', 'caa', 'fanart', 'tadb']) {
    const dir = join(__dirname, '../../config/cache/images', source);
    const entries = await promises.readdir(dir).catch(() => []);
    await Promise.all(
      entries.map((entry) =>
        promises.rm(join(dir, entry), { recursive: true, force: true })
      )
    );
  }
});

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers, redirect: 'manual' });

describe('GET /imageproxy/tmdb/...', () => {
  it('sends someone signed out to TMDB for an image not cached yet', async () => {
    upstream = [];
    const res = await get(poster('a'));
    assert.equal(res.status, 302);
    assert.equal(
      res.headers.get('location'),
      `https://image.tmdb.org${poster('a')}`
    );
    assert.deepEqual(upstream, [], 'nothing fetched onto the server');
  });

  it('does not take a signed-out session, or a forged cookie, for someone signed in', async () => {
    upstream = [];
    for (const cookie of [
      cookieFor('signed-out'),
      'connect.sid=s%3Asigned-in.forgedsignature',
      'connect.sid=signed-in',
    ]) {
      const res = await get(poster('c'), { cookie });
      assert.equal(res.status, 302, cookie);
    }
    assert.deepEqual(upstream, []);
  });

  it('fetches and keeps it for someone signed in, as a proper image', async () => {
    upstream = [];
    const res = await get(poster('b'), SIGNED_IN);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(
      res.headers.get('cache-control'),
      'public, max-age=31536000, immutable'
    );
    assert.equal(res.headers.get('etag'), '"poster1"');
    assert.equal((await res.arrayBuffer()).byteLength, 4);
    assert.deepEqual(upstream, [poster('b')]);
  });

  it('serves what is cached to anyone, and says when they already have it', async () => {
    upstream = [];
    const res = await get(poster('b'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('os-cache-status'), 'HIT');

    const again = await get(poster('b'), { 'if-none-match': '"poster1"' });
    assert.equal(again.status, 304);
    assert.deepEqual(upstream, []);
  });

  it('answers 404 for an image TMDB does not have, for a while', async () => {
    const res = await get(poster('gone'), SIGNED_IN);
    assert.equal(res.status, 404);
    // The browser need not ask again while the server would not either.
    assert.equal(res.headers.get('cache-control'), 'public, max-age=600');
  });

  it('refuses anything that is not an image path', async () => {
    upstream = [];
    for (const path of [
      '/t/p/w300/../../3/movie/550',
      '/3/movie/550',
      '/t/p/w300/file.html',
      '/t/p/w300/file',
    ]) {
      const res = await get(path, SIGNED_IN);
      assert.equal(res.status, 400, path);
    }
    assert.deepEqual(upstream, []);
  });

  it('takes the shapes the app asks for', async () => {
    for (const path of [
      '/t/p/original/abc.png',
      '/t/p/w780_filter(duotone,ffffff,bababa)/abc.png',
      '/t/p/w1920_and_h800_multi_faces/abc.jpg',
      '/t/p/w154/logo.svg',
      // As most backdrops in the app are addressed: a doubled slash.
      '/t/p/w1920_and_h800_multi_faces//abc.jpg',
      '/t/p/w1440_and_h320_multi_faces//abc.jpg',
    ]) {
      const res = await get(path);
      assert.equal(res.status, 302, path);
      assert.equal(
        res.headers.get('location'),
        `https://image.tmdb.org${path.replace('//', '/')}`,
        path
      );
    }
  });

  it('serves AVIF and WebP copies, and smaller ones, to keep for good', async () => {
    const backdrop = `/t/p/w1920_and_h800_multi_faces/${unique}real.jpg`;
    for (const [query, type, width] of [
      ['?f=avif', 'image/avif', 1920],
      ['?f=webp', 'image/webp', 1920],
      ['?f=avif&w=780', 'image/avif', 780],
    ] as const) {
      const res = await get(`${backdrop}${query}`, SIGNED_IN);
      assert.equal(res.status, 200, query);
      assert.equal(res.headers.get('content-type'), type, query);
      assert.equal(
        res.headers.get('cache-control'),
        'public, max-age=31536000, immutable',
        query
      );
      const body = Buffer.from(await res.arrayBuffer());
      assert.ok(body.length < realJpeg.length, `${query} is smaller`);
      assert.equal((await sharp(body).metadata()).width, width, query);

      const again = await get(`${backdrop}${query}`, {
        'if-none-match': res.headers.get('etag') as string,
      });
      assert.equal(again.status, 304, `${query} again`);
    }
  });

  it('refuses options it does not offer', async () => {
    const backdrop = `/t/p/w1920_and_h800_multi_faces/${unique}real.jpg`;
    for (const query of [
      '?f=gif',
      '?w=780',
      '?f=avif&w=500',
      '?f=avif&w=0780',
      '?f=avif&q=10',
      '?f=avif&f=webp',
    ]) {
      const res = await get(`${backdrop}${query}`, SIGNED_IN);
      assert.equal(res.status, 400, query);
    }
  });

  it('serves the original, to keep, for a picture it cannot convert', async () => {
    const res = await get(`${poster('b')}?f=avif`, SIGNED_IN);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(
      res.headers.get('cache-control'),
      'public, max-age=31536000, immutable'
    );
  });

  it('converts only a few pictures for someone signed out', async () => {
    const path = (n: number) =>
      `/t/p/w1920_and_h800_multi_faces/${unique}real-out${n}.jpg`;
    const types: string[] = [];
    for (let n = 0; n < 22; n += 1) {
      // Cached by someone signed in, then asked for converted by anyone.
      await get(path(n), SIGNED_IN);
      const res = await get(`${path(n)}?f=webp&w=480`);
      assert.equal(res.status, 200);
      types.push(
        `${res.headers.get('content-type')} ${res.headers.get('cache-control')}`
      );
    }
    // Twenty converted, then the original, not to be kept under the
    // converted address.
    assert.deepEqual(types, [
      ...Array(20).fill('image/webp public, max-age=31536000, immutable'),
      'image/jpeg no-store',
      'image/jpeg no-store',
    ]);
    // A copy already made is served to anyone.
    const made = await get(`${path(0)}?f=webp&w=480`);
    assert.equal(made.headers.get('content-type'), 'image/webp');
  });

  it('gives an image TMDB sent without an ETag one of its own', async () => {
    upstream = [];
    const res = await get(poster('noetag'), SIGNED_IN);
    const etag = res.headers.get('etag');
    assert.ok(etag && etag.startsWith('"') && etag.length > 10, String(etag));
    const again = await get(poster('noetag'), { 'if-none-match': etag! });
    assert.equal(again.status, 304);
  });
});

describe('music’s pictures', () => {
  const ALBUM = 'b1392450-e666-3926-a536-22c65f834433';
  const ARTIST = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
  /** Albums only these tests ask for, so each starts uncached. */
  const COVER = `${unique.replace(/\D/g, '').padStart(8, '0').slice(-8)}-e666-3926-a536-22c65f834433`;
  const MISSING = `${COVER.slice(0, 8)}-0000-3926-a536-22c65f834433`;
  const music = (path: string, headers: Record<string, string> = {}) =>
    fetch(base.replace(/\/tmdb$/, path), { headers, redirect: 'manual' });

  /*
   * The Cover Art Archive and archive.org, standing in: the archive
   * redirects each cover to a file at archive.org, which says it keeps it
   * only briefly, or answers 404 for an album with no cover.
   */
  let archived: string[] = [];
  let archive: http.Server;
  let caa: http.Server;
  before(async () => {
    archive = http.createServer((req, res) => {
      archived.push(req.url ?? '');
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'max-age=60',
        ETag: '"5f4a8b2c-1a2b3"',
      });
      res.end(realJpeg);
    });
    await new Promise<void>((r) => archive.listen(0, '127.0.0.1', () => r()));
    const archivePort = (archive.address() as AddressInfo).port;
    caa = http.createServer((req, res) => {
      archived.push(req.url ?? '');
      const match = /^\/release-group\/([\w-]+)\/front(?:-(\d+))?$/.exec(
        req.url ?? ''
      );
      if (!match || match[1] === MISSING) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      res.writeHead(307, {
        Location: `http://127.0.0.1:${archivePort}/download/${match[1]}_thumb${match[2] ?? ''}.jpg`,
      });
      res.end();
    });
    await new Promise<void>((r) => caa.listen(0, '127.0.0.1', () => r()));
    // A real client, so redirects are followed as they are in use.
    Object.defineProperty(musicImageProxy('caa'), 'axios', {
      configurable: true,
      value: axios.create({
        baseURL: `http://127.0.0.1:${(caa.address() as AddressInfo).port}`,
        timeout: 5000,
      }),
    });
    // fanart.tv and TheAudioDB send no lifetime of their own here.
    for (const source of ['fanart', 'tadb'] as const) {
      Object.defineProperty(musicImageProxy(source), 'axios', {
        configurable: true,
        value: {
          get: async () => ({
            data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
            headers: { 'content-type': 'image/jpeg' },
          }),
        },
      });
    }
  });
  after(() => {
    archive.close();
    caa.close();
  });

  it('come from the Cover Art Archive, fanart.tv and TheAudioDB', async () => {
    for (const [path, origin] of [
      [`/caa/release-group/${ALBUM}/front-500`, 'https://coverartarchive.org'],
      [`/caa/release/${ALBUM}/front`, 'https://coverartarchive.org'],
      [
        `/fanart/fanart/music/${ARTIST}/artistthumb/radiohead-5.jpg`,
        'https://assets.fanart.tv',
      ],
      ['/tadb/images/media/artist/thumb/abc.jpg', 'https://r2.theaudiodb.com'],
    ]) {
      // Someone signed out is sent to the picture where it is.
      const res = await music(path);
      assert.equal(res.status, 302, path);
      assert.equal(
        res.headers.get('location'),
        `${origin}${path.replace(/^\/\w+/, '')}`
      );
    }
  });

  it('follow the Cover Art Archive to archive.org, and keep a cover a month', async () => {
    archived = [];
    const path = `/caa/release-group/${COVER}/front-500`;
    const res = await music(path, SIGNED_IN);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    // Not immutable: someone can put a better cover at the same address.
    assert.equal(res.headers.get('cache-control'), 'public, max-age=2592000');
    assert.equal(
      Buffer.compare(Buffer.from(await res.arrayBuffer()), realJpeg),
      0
    );
    assert.deepEqual(archived, [
      `/release-group/${COVER}/front-500`,
      `/download/${COVER}_thumb500.jpg`,
    ]);

    archived = [];
    const again = await music(path);
    assert.equal(again.status, 200, 'served to anyone once cached');
    assert.equal(again.headers.get('os-cache-status'), 'HIT');
    assert.equal(
      (await music(path, { 'if-none-match': res.headers.get('etag')! })).status,
      304
    );
    assert.deepEqual(archived, []);
  });

  it('serves a cover as AVIF and WebP, though its address has no file name', async () => {
    const path = `/caa/release-group/${COVER}/front-500`;
    for (const [format, type] of [
      ['avif', 'image/avif'],
      ['webp', 'image/webp'],
    ]) {
      const res = await music(`${path}?f=${format}`, SIGNED_IN);
      assert.equal(res.status, 200, format);
      assert.equal(res.headers.get('content-type'), type);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=2592000');
      assert.ok(
        (await res.arrayBuffer()).byteLength < realJpeg.length,
        `${format} is smaller`
      );
    }
    // And smaller ones of a large cover, as for a backdrop.
    const small = await music(
      `/caa/release-group/${COVER}/front-1200?f=webp&w=480`,
      SIGNED_IN
    );
    assert.equal(small.status, 200);
    assert.equal(
      (await sharp(Buffer.from(await small.arrayBuffer())).metadata()).width,
      480
    );
  });

  it('remembers a missing cover for hours, and tells the browser to', async () => {
    archived = [];
    const path = `/caa/release-group/${MISSING}/front-500`;
    const res = await music(path, SIGNED_IN);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=21600');
    assert.equal((await music(path, SIGNED_IN)).status, 404);
    assert.equal(
      (await music(`${path}?f=avif`, SIGNED_IN)).status,
      404,
      'nor its copies'
    );
    assert.deepEqual(archived, [`/release-group/${MISSING}/front-500`]);
  });

  it('keep pictures of artists a year, as posters are', async () => {
    for (const path of [
      `/fanart/fanart/music/${ARTIST}/artistthumb/radiohead-5.jpg`,
      '/tadb/images/media/artist/thumb/abc.jpg',
    ]) {
      const res = await music(path, SIGNED_IN);
      assert.equal(res.status, 200, path);
      assert.equal(
        res.headers.get('cache-control'),
        'public, max-age=31536000, immutable',
        path
      );
    }
  });

  it('are only the pictures those hosts keep', async () => {
    for (const path of [
      `/caa/release-group/${ALBUM}/back`,
      `/caa/release-group/${ALBUM}/front-999`,
      '/caa/release-group/not-an-id/front-500',
      `/caa/artist/${ARTIST}/front-500`,
      `/fanart/fanart/movies/${ARTIST}/poster/x.jpg`,
      `/fanart/fanart/music/${ARTIST}/artistthumb/x.html`,
      '/tadb/api/v1/json/key/artist-mb.php',
      '/tadb/images/media/artist/thumb/x.svg',
      '/lastfm/i/u/300x300/x.jpg',
    ]) {
      assert.equal((await music(path)).status, 400, path);
    }
  });
});
