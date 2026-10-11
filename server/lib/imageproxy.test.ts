import ImageProxy, {
  ImageNotFoundError,
  maxAgeOf,
} from '@server/lib/imageproxy';
import assert from 'node:assert/strict';
import { promises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Regression cover for two faults that produced blank posters:
 *
 *  - the cache directory was cleared before writing, so a concurrent request
 *    for the same image could delete the file another had just written;
 *  - the read then took whatever the directory listed first, including a
 *    partially written temporary file.
 */
describe('image proxy cache', () => {
  const cacheRoot = join(tmpdir(), `seerr-imageproxy-test-${process.pid}`);
  // The proxy resolves its cache directory when the module loads, so the
  // directory cannot be redirected from here. Unique paths per run keep every
  // test genuinely cold instead.
  const unique = `${process.pid}-${Date.now()}`;
  const path = (name: string) => `/t/p/w500/${unique}-${name}.jpg`;
  let upstreamCalls = 0;
  let proxy: ImageProxy;

  before(async () => {
    process.env.CONFIG_DIRECTORY = cacheRoot;
    await promises.rm(cacheRoot, { recursive: true, force: true });

    proxy = new ImageProxy('tmdb', 'https://image.tmdb.org', {});

    // Stand in for the network; the suite blocks outbound requests.
    Object.defineProperty(proxy, 'axios', {
      configurable: true,
      value: {
        get: async () => {
          upstreamCalls++;

          return {
            data: Buffer.from('FAKE-JPEG-BYTES'),
            headers: {
              'content-type': 'image/jpeg',
              'cache-control': 'max-age=86400',
              etag: 'W/"abc123"',
            },
          };
        },
      },
    });
  });

  after(async () => {
    await promises.rm(cacheRoot, { recursive: true, force: true });
    delete process.env.CONFIG_DIRECTORY;

    // The proxy wrote into the default cache directory, since it resolves
    // that at module load. Remove only this run's entries.
    const defaultDir = join(__dirname, '../../config/cache/images/tmdb');

    try {
      const entries = await promises.readdir(defaultDir);

      await Promise.all(
        entries.map(async (entry) => {
          const files = await promises
            .readdir(join(defaultDir, entry))
            .catch(() => [] as string[]);

          if (files.length) {
            await promises.rm(join(defaultDir, entry), {
              recursive: true,
              force: true,
            });
          }
        })
      );
    } catch {
      // Nothing written; nothing to clean.
    }
  });

  it('fetches once and serves the cached copy afterwards', async () => {
    upstreamCalls = 0;

    const first = await proxy.getImage(path('first'));
    assert.equal(first.meta.cacheMiss, true);
    assert.equal(upstreamCalls, 1);

    const second = await proxy.getImage(path('first'));
    assert.equal(second.meta.cacheMiss, false);
    assert.ok(second.imageBuffer.length > 0);
    assert.equal(upstreamCalls, 1, 'a cached image must not be refetched');
  });

  it('collapses concurrent requests for the same new image', async () => {
    upstreamCalls = 0;

    const results = await Promise.all(
      Array.from({ length: 12 }, () => proxy.getImage(path('burst')))
    );

    assert.ok(
      results.every((result) => result.imageBuffer.length > 0),
      'every caller should get an image, not a blank'
    );
    assert.equal(
      upstreamCalls,
      1,
      'twelve callers racing for one image should make one request'
    );
  });

  it('serves a cached image under load without refetching', async () => {
    await proxy.getImage(path('warm'));
    upstreamCalls = 0;

    const results = await Promise.all(
      Array.from({ length: 20 }, () => proxy.getImage(path('warm')))
    );

    assert.ok(results.every((result) => result.imageBuffer.length > 0));
    assert.equal(upstreamCalls, 0);
  });

  it('keeps serving a complete image while the same entry is rewritten', async () => {
    // The original fault cleared the directory before writing, so a reader
    // arriving mid-write found nothing. Hammering one path with concurrent
    // reads and writes must never produce an empty buffer.
    await proxy.getImage(path('rewrite'));

    const results = await Promise.all(
      Array.from({ length: 30 }, () => proxy.getImage(path('rewrite')))
    );

    assert.ok(
      results.every((result) => result.imageBuffer.length > 0),
      'a concurrent rewrite must never surface a blank image'
    );
  });

  it('does not let a stalled fetch block later images', async () => {
    // A fetch that never answers must give up (the proxy sets a timeout)
    // rather than keep that poster, and whoever waits on it, waiting.
    const slow = new ImageProxy('tmdb', 'https://image.tmdb.org', {});
    let released = false;

    Object.defineProperty(slow, 'axios', {
      configurable: true,
      value: {
        get: async (requested: string) => {
          if (requested.includes('hang')) {
            await new Promise((_resolve, reject) =>
              setTimeout(() => reject(new Error('timeout')), 50)
            );
          }

          released = true;

          return {
            data: Buffer.from('IMG'),
            headers: {
              'content-type': 'image/jpeg',
              'cache-control': 'max-age=86400',
              etag: 'e',
            },
          };
        },
      },
    });

    // A fetch that never answers must reject rather than hang forever.
    await assert.rejects(() => slow.getImage(path('hang')));

    // And a later image still resolves, having got a slot back.
    const later = await slow.getImage(path('follows-a-stall'));
    assert.ok(later.imageBuffer.length > 0);
    assert.equal(released, true);
  });

  it('reports a stale entry rather than discarding it', async () => {
    const image = await proxy.getImage(path('stale'));

    // An expired entry is still served and refreshed in the background, so a
    // poster never disappears while it revalidates.
    assert.ok(image.imageBuffer.length > 0);
    assert.equal(typeof image.meta.isStale, 'boolean');
  });
});

describe('what the image cache keeps, and how it serves it', () => {
  const unique = `${process.pid}-${Date.now()}-kept`;

  after(async () => {
    // Written into the default cache directory (see above); remove them.
    const defaultDir = join(__dirname, '../../config/cache/images/tmdb');
    const entries = await promises.readdir(defaultDir).catch(() => []);
    await Promise.all(
      entries.map((entry) =>
        promises.rm(join(defaultDir, entry), { recursive: true, force: true })
      )
    );
  });
  const path = (name: string, ext = 'jpg') =>
    `/t/p/w300/${unique}-${name}.${ext}`;

  /** A proxy whose upstream answers with the given response. */
  const proxyAnswering = (
    answer: (path: string) => {
      status?: number;
      data?: Buffer;
      headers?: Record<string, string>;
    }
  ) => {
    const calls: string[] = [];
    const proxy = new ImageProxy('tmdb', 'https://image.tmdb.org', {});
    Object.defineProperty(proxy, 'axios', {
      configurable: true,
      value: {
        get: async (requested: string) => {
          calls.push(requested);
          const { status = 200, data, headers = {} } = answer(requested);
          if (status >= 400) {
            throw Object.assign(new Error(`status ${status}`), {
              response: { status },
            });
          }
          return { data: data ?? Buffer.from('IMG'), headers };
        },
      },
    });
    return { proxy, calls };
  };

  it('reads max-age whatever order Cache-Control lists it in', () => {
    assert.equal(maxAgeOf('max-age=31536000'), 31536000);
    assert.equal(maxAgeOf('public, max-age=600'), 600);
    assert.equal(maxAgeOf('max-age=31536000, public'), 31536000);
    assert.equal(maxAgeOf('public, max-age=31536000, immutable'), 31536000);
    assert.equal(maxAgeOf('s-maxage=5, max-age=60'), 60);
    assert.equal(maxAgeOf('no-cache'), null);
    assert.equal(maxAgeOf(undefined), null);
  });

  it('keeps an image as long as its host allows', async () => {
    const { proxy } = proxyAnswering(() => ({
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'max-age=31536000, public',
      },
    }));
    const image = await proxy.getImage(path('long'));
    assert.equal(image.meta.curRevalidate, 31536000);
  });

  it('serves each image with its real media type', async () => {
    const { proxy } = proxyAnswering((requested) => ({
      headers: {
        'content-type': requested.endsWith('.svg')
          ? 'image/svg+xml'
          : 'image/jpeg',
      },
    }));
    assert.equal(
      (await proxy.getImage(path('photo'))).meta.contentType,
      'image/jpeg'
    );
    // "image/svg" (from the file extension) is not a type browsers will
    // draw; a logo served that way would be blank.
    assert.equal(
      (await proxy.getImage(path('logo', 'svg'))).meta.contentType,
      'image/svg+xml'
    );
    // And the same once it comes from the cache.
    assert.equal(
      (await proxy.getImage(path('logo', 'svg'))).meta.contentType,
      'image/svg+xml'
    );
  });

  it('does not keep or serve something that is not an image', async () => {
    const { proxy, calls } = proxyAnswering(() => ({
      data: Buffer.from('<html>error</html>'),
      headers: { 'content-type': 'text/html' },
    }));
    await assert.rejects(() => proxy.getImage(path('page')));
    assert.equal(await proxy.peek(path('page')), null);
    await assert.rejects(() => proxy.getImage(path('page')));
    assert.equal(calls.length, 2, 'nothing was cached, so it is asked again');
  });

  it('says an image does not exist, and does not keep asking', async () => {
    const { proxy, calls } = proxyAnswering(() => ({ status: 404 }));
    await assert.rejects(
      () => proxy.getImage(path('gone')),
      (e) => e instanceof ImageNotFoundError
    );
    await assert.rejects(
      () => proxy.getImage(path('gone')),
      (e) => e instanceof ImageNotFoundError
    );
    assert.equal(calls.length, 1);
  });

  it('can look in the cache without fetching', async () => {
    const { proxy, calls } = proxyAnswering(() => ({
      headers: { 'content-type': 'image/png' },
    }));
    assert.equal(await proxy.peek(path('unseen', 'png')), null);
    assert.equal(calls.length, 0);
    await proxy.getImage(path('unseen', 'png'));
    assert.ok(await proxy.peek(path('unseen', 'png')));
    assert.equal(calls.length, 1);
  });
});
