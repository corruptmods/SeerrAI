import type * as ImageProxyModule from '@server/lib/imageproxy';
import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { promises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import sharp from 'sharp';

/*
 * The image cache's own copies and upkeep: converted and smaller copies,
 * checking a stale image with its host instead of downloading it again, and
 * the size limit. In a cache directory of its own, as the size limit looks
 * at everything in it.
 */

const configDir = join(tmpdir(), `seerr-images-${process.pid}-${Date.now()}`);
process.env.CONFIG_DIRECTORY = configDir;
const imagesDir = join(configDir, 'cache/images');

type Module = typeof ImageProxyModule;
let ImageProxy: Module['default'];

interface Answer {
  status?: number;
  data?: Buffer;
  headers?: Record<string, string>;
}

/** A proxy whose host answers as told, recording each request's headers. */
const proxyAnswering = (answer: (path: string) => Answer) => {
  const calls: { path: string; headers: Record<string, string> }[] = [];
  const proxy = new ImageProxy('tmdb', 'https://image.tmdb.org', {});
  Object.defineProperty(proxy, 'axios', {
    configurable: true,
    value: {
      get: async (
        path: string,
        config: {
          headers?: Record<string, string>;
          validateStatus?: (status: number) => boolean;
        }
      ) => {
        calls.push({ path, headers: config.headers ?? {} });
        const { status = 200, data, headers = {} } = answer(path);
        const ok = config.validateStatus
          ? config.validateStatus(status)
          : status < 300;
        if (!ok) {
          throw Object.assign(new Error(`status ${status}`), {
            response: { status },
          });
        }
        return { status, data: data ?? Buffer.alloc(0), headers };
      },
    },
  });
  return { proxy, calls };
};

/** A real JPEG of the given size, as TMDB would send. */
const jpeg = (width: number, height: number, seed = 0) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 40 + seed, g: 90, b: 160 },
    },
  })
    // Some detail, so it is not trivially compressible.
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}"><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 3}" fill="#e0c050"/><text x="10" y="40" font-size="30" fill="white">Seerr ${seed}</text></svg>`
        ),
      },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();

const JPEG_HEADERS = {
  'content-type': 'image/jpeg',
  'cache-control': 'max-age=31536000',
};

let counter = 0;
const unique = (name: string) =>
  `/t/p/w1920_and_h800_multi_faces/${name}-${++counter}.jpg`;

before(async () => {
  ({ default: ImageProxy } = await import('@server/lib/imageproxy'));
});

after(async () => {
  await promises.rm(configDir, { recursive: true, force: true });
});

describe('converted copies', () => {
  let backdrop: Buffer;

  before(async () => {
    backdrop = await jpeg(1920, 800);
  });

  it('converts to AVIF and WebP once, keeps them, and serves them after', async () => {
    const { proxy } = proxyAnswering(() => ({
      data: backdrop,
      headers: JPEG_HEADERS,
    }));
    const path = unique('backdrop');
    const original = await proxy.getImage(path);

    for (const format of ['avif', 'webp'] as const) {
      const made = await proxy.getVariant(path, { format }, original, {
        convert: true,
      });
      assert.equal(made.status, 'ready');
      if (made.status !== 'ready') return;
      assert.equal(made.image.meta.contentType, `image/${format}`);
      assert.ok(
        made.image.imageBuffer.length < backdrop.length,
        `${format} is smaller than the JPEG`
      );
      const meta = await sharp(made.image.imageBuffer).metadata();
      assert.deepEqual([meta.width, meta.height], [1920, 800]);
      assert.equal(made.image.meta.curRevalidate, 31536000);

      // Kept: asked again without leave to convert, it is there.
      const kept = await proxy.getVariant(path, { format }, original, {
        convert: false,
      });
      assert.equal(kept.status, 'ready');
      if (kept.status !== 'ready') return;
      assert.equal(kept.image.meta.cacheMiss, false);
      assert.ok(kept.image.imageBuffer.equals(made.image.imageBuffer));
    }
  });

  it('makes smaller copies at the width asked for, keeping the shape', async () => {
    const { proxy } = proxyAnswering(() => ({
      data: backdrop,
      headers: JPEG_HEADERS,
    }));
    const path = unique('narrow');
    const original = await proxy.getImage(path);
    const made = await proxy.getVariant(
      path,
      { format: 'avif', width: 780 },
      original,
      { convert: true }
    );
    assert.equal(made.status, 'ready');
    if (made.status !== 'ready') return;
    const meta = await sharp(made.image.imageBuffer).metadata();
    assert.deepEqual([meta.width, meta.height], [780, 325]);
  });

  it('never makes a copy wider than the picture', async () => {
    const small = await jpeg(300, 450);
    const { proxy } = proxyAnswering(() => ({
      data: small,
      headers: JPEG_HEADERS,
    }));
    const path = unique('poster');
    const original = await proxy.getImage(path);
    const made = await proxy.getVariant(
      path,
      { format: 'webp', width: 1280 },
      original,
      { convert: true }
    );
    assert.equal(made.status, 'ready');
    if (made.status !== 'ready') return;
    const meta = await sharp(made.image.imageBuffer).metadata();
    assert.equal(meta.width, 300);
  });

  it('says pending, without converting, when not allowed to convert', async () => {
    const { proxy } = proxyAnswering(() => ({
      data: backdrop,
      headers: JPEG_HEADERS,
    }));
    const path = unique('not-yet');
    const original = await proxy.getImage(path);
    const result = await proxy.getVariant(path, { format: 'avif' }, original, {
      convert: false,
    });
    assert.equal(result.status, 'pending');
  });

  it('makes a new copy once the original has changed', async () => {
    let current = backdrop;
    const { proxy } = proxyAnswering(() => ({
      data: current,
      headers: JPEG_HEADERS,
    }));
    const path = unique('changed');
    const first = await proxy.getVariant(
      path,
      { format: 'webp' },
      await proxy.getImage(path),
      { convert: true }
    );
    current = await jpeg(1920, 800, 60);
    const replaced = await proxy.getVariant(
      path,
      { format: 'webp' },
      { ...(await proxy.getImage(path)), imageBuffer: current },
      { convert: true }
    );
    assert.equal(first.status, 'ready');
    assert.equal(replaced.status, 'ready');
    if (first.status !== 'ready' || replaced.status !== 'ready') return;
    assert.ok(!first.image.imageBuffer.equals(replaced.image.imageBuffer));
    assert.equal(replaced.image.meta.cacheMiss, true);
  });

  it('keeps the original where converting would only make it bigger', async () => {
    // A tiny, flat image: its JPEG is already about as small as it gets.
    const tiny = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#000' },
    })
      .jpeg({ quality: 10 })
      .toBuffer();
    const { proxy } = proxyAnswering(() => ({
      data: tiny,
      headers: JPEG_HEADERS,
    }));
    const path = unique('tiny');
    const result = await proxy.getVariant(
      path,
      { format: 'avif' },
      await proxy.getImage(path),
      { convert: true }
    );
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    assert.ok(result.image.imageBuffer.length <= tiny.length);
  });

  it('leaves alone what it cannot convert', async () => {
    const { proxy } = proxyAnswering(() => ({
      data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      headers: { 'content-type': 'image/svg+xml' },
    }));
    const path = '/t/p/w45/logo.svg';
    const result = await proxy.getVariant(
      path,
      { format: 'avif' },
      await proxy.getImage(path),
      { convert: true }
    );
    assert.equal(result.status, 'unavailable');
  });
});

describe('checking a stale image with its host', () => {
  /** Makes the cached copy of a path look expired. */
  const expire = async (
    proxy: InstanceType<Module['default']>,
    path: string
  ) => {
    const image = await proxy.getImage(path);
    const dir = join(imagesDir, 'tmdb', image.meta.cacheKey);
    const [file] = await promises.readdir(dir);
    const [maxAge, , etag, ext] = file.split('.');
    const longAgo = Date.now() - 1000;
    await promises.rename(
      join(dir, file),
      join(dir, `${maxAge}.${longAgo}.${etag}.${ext}`)
    );
  };

  it('asks only if it changed, and keeps the copy when it has not', async () => {
    const picture = await jpeg(300, 450);
    let unchanged = false;
    const { proxy, calls } = proxyAnswering(() =>
      unchanged
        ? { status: 304, headers: { 'cache-control': 'max-age=600' } }
        : {
            data: picture,
            headers: { ...JPEG_HEADERS, etag: '"0123456789abcdef0123"' },
          }
    );
    const path = unique('revalidate');
    await proxy.getImage(path);
    await expire(proxy, path);
    unchanged = true;

    const stale = await proxy.getImage(path);
    assert.equal(stale.meta.isStale, true, 'served at once, as it was');
    // The check runs behind it.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const check = calls[calls.length - 1];
    assert.equal(check.headers['If-None-Match'], '"0123456789abcdef0123"');
    assert.ok(
      !Number.isNaN(Date.parse(check.headers['If-Modified-Since'])),
      'and since when'
    );

    const renewed = await proxy.getImage(path);
    assert.equal(renewed.meta.isStale, false);
    assert.equal(renewed.meta.curRevalidate, 600);
    assert.ok(renewed.imageBuffer.equals(picture), 'the same bytes, kept');
    assert.equal(calls.length, 2, 'nothing downloaded again');
  });

  it('takes the new picture when the host has one', async () => {
    let picture = await jpeg(300, 450);
    const { proxy } = proxyAnswering(() => ({
      data: picture,
      headers: JPEG_HEADERS,
    }));
    const path = unique('replaced');
    await proxy.getImage(path);
    await expire(proxy, path);
    picture = await jpeg(300, 450, 90);

    await proxy.getImage(path);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const fresh = await proxy.getImage(path);
    assert.ok(fresh.imageBuffer.equals(picture));
    assert.equal(fresh.meta.isStale, false);
  });

  it("sends back TMDB's other kind of ETag, hex groups joined by a hyphen", async () => {
    const picture = await jpeg(300, 450);
    const { proxy, calls } = proxyAnswering(() => ({
      data: picture,
      headers: { ...JPEG_HEADERS, etag: '"67ef93d1-13c28"' },
    }));
    const path = unique('hyphenated');
    await proxy.getImage(path);
    await expire(proxy, path);
    await proxy.getImage(path);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      calls[calls.length - 1].headers['If-None-Match'],
      '"67ef93d1-13c28"'
    );
  });

  it('does not send back an ETag it only kept part of', async () => {
    const picture = await jpeg(300, 450);
    const { proxy, calls } = proxyAnswering(() => ({
      data: picture,
      headers: { ...JPEG_HEADERS, etag: 'W/"weak-1"' },
    }));
    const path = unique('weak');
    await proxy.getImage(path);
    await expire(proxy, path);
    await proxy.getImage(path);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const check = calls[calls.length - 1];
    assert.equal(check.headers['If-None-Match'], undefined);
    assert.ok(check.headers['If-Modified-Since']);
  });
});

describe('the size limit', () => {
  const MB = 1024 * 1024;

  /** An entry of the given size, last used minutesAgo. */
  const entry = async (
    source: string,
    name: string,
    bytes: number,
    minutesAgo: number
  ) => {
    const dir = join(imagesDir, source, name);
    await promises.mkdir(dir, { recursive: true });
    const file = join(dir, `31536000.${Date.now() + 1e9}..jpg`);
    // Sparse: its size is what counts, not what it takes on this disk.
    await promises.writeFile(file, '');
    await promises.truncate(file, bytes);
    const when = (Date.now() - minutesAgo * 60000) / 1000;
    await promises.utimes(file, when, when);
  };

  const left = async (source: string) =>
    (await promises.readdir(join(imagesDir, source)).catch(() => [])).sort();

  beforeEach(async () => {
    await promises.rm(imagesDir, { recursive: true, force: true });
  });

  it('removes the least recently used, from every source, down to 90%', async () => {
    getSettings().main.imageCacheMaxMb = 256;
    // 300 MB in all: over 256, so trimmed to at most 230.4.
    await entry('tmdb', 'old-poster', 40 * MB, 300);
    await entry('tvdb', 'old-banner', 40 * MB, 200);
    await entry('caa', 'left-by-an-old-version', 20 * MB, 100000);
    await entry('tmdb', 'recent-poster', 100 * MB, 5);
    await entry('tmdb', 'just-now', 100 * MB, 0);

    await ImageProxy.trimToLimit();

    assert.deepEqual(await left('tmdb'), ['just-now', 'recent-poster']);
    assert.deepEqual(await left('tvdb'), []);
    assert.deepEqual(await left('caa'), []);
    assert.ok((await ImageProxy.getTotalSize()) <= 256 * MB * 0.9);
  });

  it('leaves the cache alone while it is under the limit', async () => {
    getSettings().main.imageCacheMaxMb = 256;
    await entry('tmdb', 'a', 10 * MB, 1000);
    await entry('tvdb', 'b', 10 * MB, 1000);
    await ImageProxy.trimToLimit();
    assert.deepEqual([await left('tmdb'), await left('tvdb')], [['a'], ['b']]);
  });

  it('marks an image used when it is served, so it is kept over others', async () => {
    getSettings().main.imageCacheMaxMb = 256;
    const big = await jpeg(64, 64);
    const { proxy } = proxyAnswering(() => ({
      data: big,
      headers: JPEG_HEADERS,
    }));
    const path = unique('served');
    const image = await proxy.getImage(path);
    const dir = join(imagesDir, 'tmdb', image.meta.cacheKey);
    const [file] = await promises.readdir(dir);
    const longAgo = (Date.now() - 600 * 60000) / 1000;
    await promises.utimes(join(dir, file), longAgo, longAgo);

    // A fresh proxy, as after a restart: this process has not marked it.
    const { proxy: later } = proxyAnswering(() => ({
      data: big,
      headers: JPEG_HEADERS,
    }));
    Reflect.set(ImageProxy, 'touched', new Map());
    await later.getImage(path);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { mtimeMs } = await promises.stat(join(dir, file));
    assert.ok(Date.now() - mtimeMs < 60000, 'marked as just used');
  });

  it('is never set below its minimum', async () => {
    getSettings().main.imageCacheMaxMb = 10;
    assert.equal(ImageProxy.sizeLimit(), 256 * MB);
    getSettings().main.imageCacheMaxMb = undefined;
    assert.equal(ImageProxy.sizeLimit(), 2048 * MB);
  });
});
