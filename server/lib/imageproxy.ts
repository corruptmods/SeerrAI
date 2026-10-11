import type { ImageFormat, ImageWidth } from '@server/constants/images';
import {
  DEFAULT_IMAGE_CACHE_MAX_MB,
  MIN_IMAGE_CACHE_MAX_MB,
} from '@server/constants/images';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import { userAgentRequestInterceptor } from '@server/utils/userAgent';
import axios, { type AxiosInstance } from 'axios';
import rateLimit, { type rateLimitOptions } from 'axios-rate-limit';
import { createHash } from 'crypto';
import { promises } from 'fs';
import mime from 'mime';
import path, { join } from 'path';
import type sharpType from 'sharp';

type ImageResponse = {
  meta: {
    revalidateAfter: number;
    curRevalidate: number;
    isStale: boolean;
    etag: string;
    extension: string | null;
    /** The media type to serve it as: image/jpeg, image/svg+xml... */
    contentType: string;
    cacheKey: string;
    cacheMiss: boolean;
    /** When it was fetched, or last confirmed unchanged upstream (ms). */
    storedAt: number;
    /** Its file in the cache entry's directory. */
    fileName: string;
  };
  imageBuffer: Buffer;
};

/** A smaller or better-compressed copy of an image (see getVariant). */
export type ImageVariant = { format: ImageFormat; width?: ImageWidth };

/**
 * What getVariant found: the converted image, or why the original has to be
 * sent instead. 'pending' passes; 'unavailable' does not (the image cannot
 * be converted, or conversion cannot run here).
 */
export type VariantResult =
  | { status: 'ready'; image: ImageResponse }
  | { status: 'pending' | 'unavailable' };

/**
 * How long to wait for an upstream image. Without it a fetch that never
 * answers keeps the browser waiting on that poster for good.
 */
const UPSTREAM_TIMEOUT_MS = 15000;

/** Kept this long when the upstream does not say. */
const DEFAULT_MAX_AGE_S = 86400;

/** An image the upstream says does not exist is not asked for again for this long. */
const MISSING_FOR_MS = 10 * 60 * 1000;
const MISSING_LIMIT = 5000;

/**
 * A cached file's modification time is when it was last served, so the size
 * limit can remove the least recently used first. Touched at most this often
 * per file, so serving a poster does not mean a disk write every time.
 */
const TOUCH_EVERY_MS = 6 * 60 * 60 * 1000;
const TOUCH_LIMIT = 50000;

/** How long an expired image not served since is kept before cleanup. */
const EXPIRED_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

/** Over the limit, the cache is trimmed to this share of it. */
const TRIM_TO = 0.9;

/** Pictures converted at once; each takes a core while it runs. */
const CONVERSIONS_AT_ONCE = 2;
/** Conversions waiting beyond this are not queued; the original is sent. */
const CONVERSIONS_QUEUED_LIMIT = 100;
/**
 * Warming converts only while fewer than this are waiting, so the posters a
 * browser is asking for never queue behind ones it may never show.
 */
const WARM_CONVERSIONS_QUEUED_LIMIT = 10;
/**
 * How long a request waits for its picture to be converted. Past this the
 * original is sent (not to be kept), and the conversion finishes for next
 * time.
 */
const CONVERSION_WAIT_MS = 3000;

/**
 * Encoder settings. AVIF at effort 2 encoded about seven times faster than
 * sharp's default (4) for a few percent in size. In testing on backdrops
 * and posters, AVIF came out at a fifth to a quarter of the JPEG's size and
 * WebP at a third to a half.
 */
const AVIF_OPTIONS = { quality: 50, effort: 2 };
const WEBP_OPTIONS = { quality: 80, effort: 4 };

/** The image cache's size limit, in bytes, from the settings. */
const sizeLimitBytes = () => {
  const mb = Number(getSettings().main.imageCacheMaxMb);
  return (
    Math.max(
      MIN_IMAGE_CACHE_MAX_MB,
      Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_IMAGE_CACHE_MAX_MB
    ) *
    1024 *
    1024
  );
};

type Sharp = typeof sharpType;
let sharpModule: Promise<Sharp | null> | undefined;

/**
 * The image library, loaded on first use. Null when it cannot load here (a
 * build without its native part): pictures are then served as they come.
 */
const loadSharp = () =>
  (sharpModule ??= import('sharp')
    .then((module) => (module.default ?? module) as Sharp)
    .catch((e) => {
      logger.warn(
        'Images cannot be converted to AVIF or WebP here; serving them as they come',
        { label: 'Image Cache', errorMessage: e.message }
      );
      return null;
    }));

/** Whether pictures can be converted on this server. */
export const imageConversionAvailable = async () => !!(await loadSharp());

/** Runs at most a few jobs at once; the rest wait their turn. */
class Limiter {
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  public get queued() {
    return this.waiting.length;
  }

  public async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running += 1;
    try {
      return await job();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }
}

const conversions = new Limiter(CONVERSIONS_AT_ONCE);

/** A short fingerprint of an image's bytes. */
const fingerprint = (buffer: Buffer) =>
  createHash('sha1').update(buffer).digest('hex').slice(0, 20);

/**
 * The seconds a response may be kept, from its Cache-Control header, in
 * whatever order its directives come ("public, max-age=N" or
 * "max-age=N, immutable"). Null when it gives none.
 */
export const maxAgeOf = (cacheControl: unknown): number | null => {
  const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i.exec(
    typeof cacheControl === 'string' ? cacheControl : ''
  );
  return match ? Number(match[1]) : null;
};

/** The media type for a stored extension: jpg is image/jpeg, svg image/svg+xml. */
const contentTypeOf = (extension: string | null) =>
  (extension && mime.getType(extension)) || 'application/octet-stream';

/**
 * Headers asking the host for an image only if it changed since the copy
 * kept. The ETag kept is only what is safe in a file name (quotes and the
 * W/ of a weak one dropped), so it is sent back only when it is plainly a
 * whole strong one: hex, or hex groups joined by hyphens. TMDB sends both
 * kinds (a 32-digit hash, or "67ef93d1-13c28"). If-Modified-Since covers
 * the rest.
 */
const conditionalHeaders = (meta: ImageResponse['meta']) => ({
  'If-Modified-Since': new Date(meta.storedAt).toUTCString(),
  ...(/^[0-9a-f]+(?:-[0-9a-f]+)*$/i.test(meta.etag) && meta.etag.length >= 8
    ? { 'If-None-Match': `"${meta.etag}"` }
    : {}),
});

/** The upstream has no such image (404 or 410). */
export class ImageNotFoundError extends Error {}

const baseCacheDirectory = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/cache/images`
  : path.join(__dirname, '../../config/cache/images');

class ImageProxy {
  public static async clearCache(key: string) {
    let deletedImages = 0;
    const cacheDirectory = path.join(baseCacheDirectory, key);

    try {
      const files = await promises.readdir(cacheDirectory);

      for (const file of files) {
        const filePath = path.join(cacheDirectory, file);
        const stat = await promises.lstat(filePath);

        if (stat.isDirectory()) {
          const imageFiles = await promises.readdir(filePath);

          for (const imageFile of imageFiles) {
            const [, expireAtSt] = imageFile.split('.');
            const expireAt = Number(expireAtSt);
            const now = Date.now();

            // Expired a while and not served since (serving marks it used):
            // gone. Recently expired ones stay, to be revalidated cheaply.
            const { mtimeMs } = await promises
              .stat(path.join(filePath, imageFile))
              .catch(() => ({ mtimeMs: 0 }));
            if (
              now > expireAt + EXPIRED_KEPT_MS &&
              now > mtimeMs + EXPIRED_KEPT_MS
            ) {
              await promises.rm(path.join(filePath), {
                recursive: true,
              });
              deletedImages += 1;
            }
          }
        }
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        return;
      }
      logger.error('Failed to read directory', {
        label: 'Image Cache',
        message: e.message,
      });
    }

    logger.info(`Cleared ${deletedImages} stale image(s) from cache '${key}'`, {
      label: 'Image Cache',
    });
  }

  public static async getImageStats(
    key: string
  ): Promise<{ size: number; imageCount: number }> {
    const cacheDirectory = path.join(baseCacheDirectory, key);

    const imageTotalSize = await ImageProxy.getDirectorySize(cacheDirectory);
    const imageCount = await ImageProxy.getImageCount(cacheDirectory);

    return {
      size: imageTotalSize,
      imageCount,
    };
  }

  /** The whole image cache's size on disk, every source included. */
  public static getTotalSize(): Promise<number> {
    return ImageProxy.getDirectorySize(baseCacheDirectory);
  }

  /** The size limit in force, in bytes. */
  public static sizeLimit(): number {
    return sizeLimitBytes();
  }

  private static async getDirectorySize(dir: string): Promise<number> {
    try {
      const files = await promises.readdir(dir, {
        withFileTypes: true,
      });

      const paths = files.map(async (file) => {
        const path = join(dir, file.name);

        if (file.isDirectory()) return await ImageProxy.getDirectorySize(path);

        if (file.isFile()) {
          const { size } = await promises.stat(path);

          return size;
        }

        return 0;
      });

      return (await Promise.all(paths))
        .flat(Infinity)
        .reduce((i, size) => i + size, 0);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return 0;
      }
    }

    return 0;
  }

  private static async getImageCount(dir: string) {
    try {
      const files = await promises.readdir(dir);

      return files.length;
    } catch (e) {
      if (e.code === 'ENOENT') {
        return 0;
      }
    }

    return 0;
  }

  /** The cache's size on disk as last measured, plus what was written since. */
  private static knownSize: number | undefined;
  private static trimming: Promise<void> | undefined;

  /**
   * Keeps the whole image cache, every source, under the size limit in the
   * settings: past it, the least recently served images are removed until
   * it is back to 90% of the limit. Run by the cleanup job, and as soon as
   * writes take the cache over the limit.
   */
  public static trimToLimit(): Promise<void> {
    ImageProxy.trimming ??= ImageProxy.trim().finally(() => {
      ImageProxy.trimming = undefined;
    });
    return ImageProxy.trimming;
  }

  private static async trim() {
    const limit = sizeLimitBytes();
    const entries: { dir: string; size: number; usedAt: number }[] = [];

    try {
      for (const source of await promises.readdir(baseCacheDirectory)) {
        const sourceDir = join(baseCacheDirectory, source);
        const names = await promises.readdir(sourceDir).catch(() => []);
        for (let i = 0; i < names.length; i += 200) {
          await Promise.all(
            names.slice(i, i + 200).map(async (name) => {
              const dir = join(sourceDir, name);
              const files = await promises.readdir(dir).catch(() => null);
              if (!files) {
                return;
              }
              let size = 0;
              let usedAt = 0;
              for (const file of files) {
                const stat = await promises
                  .stat(join(dir, file))
                  .catch(() => null);
                if (stat?.isFile()) {
                  size += stat.size;
                  usedAt = Math.max(usedAt, stat.mtimeMs);
                }
              }
              entries.push({ dir, size, usedAt });
            })
          );
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        logger.error('Could not measure the image cache', {
          label: 'Image Cache',
          errorMessage: e.message,
        });
      }
      return;
    }

    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    ImageProxy.knownSize = total;
    if (total <= limit) {
      return;
    }

    const target = limit * TRIM_TO;
    let removed = 0;
    entries.sort((a, b) => a.usedAt - b.usedAt);
    for (const entry of entries) {
      if (total <= target) {
        break;
      }
      await promises.rm(entry.dir, { recursive: true, force: true });
      total -= entry.size;
      removed += 1;
    }
    ImageProxy.knownSize = total;

    logger.info(
      `Removed the ${removed} least recently used image(s) to keep the image cache under its limit`,
      {
        label: 'Image Cache',
        sizeMb: Math.round(total / 1024 / 1024),
        limitMb: Math.round(limit / 1024 / 1024),
      }
    );
  }

  /** Counts a write towards the size limit, trimming once it is passed. */
  private static wrote(bytes: number) {
    if (ImageProxy.knownSize === undefined) {
      // Not measured since starting: measure (and trim, if over) now.
      ImageProxy.knownSize = 0;
      ImageProxy.trimToLimit().catch(() => undefined);
      return;
    }
    ImageProxy.knownSize += bytes;
    if (ImageProxy.knownSize > sizeLimitBytes()) {
      ImageProxy.trimToLimit().catch(() => undefined);
    }
  }

  /** When each cached file was last marked as used, by this process. */
  private static touched = new Map<string, number>();

  /** Marks a cached file as just used, for the size limit. */
  private static touch(file: string) {
    const now = Date.now();
    if (now - (ImageProxy.touched.get(file) ?? 0) < TOUCH_EVERY_MS) {
      return;
    }
    if (ImageProxy.touched.size >= TOUCH_LIMIT) {
      ImageProxy.touched.clear();
    }
    ImageProxy.touched.set(file, now);
    const seconds = now / 1000;
    promises.utimes(file, seconds, seconds).catch(() => undefined);
  }

  private axios: AxiosInstance;
  private cacheVersion;
  private key;

  constructor(
    key: string,
    baseUrl: string,
    options: {
      cacheVersion?: number;
      rateLimitOptions?: rateLimitOptions;
      headers?: Record<string, string>;
    } = {}
  ) {
    this.cacheVersion = options.cacheVersion ?? 1;
    this.key = key;
    this.axios = axios.create({
      baseURL: baseUrl,
      headers: options.headers,
      timeout: UPSTREAM_TIMEOUT_MS,
    });
    this.axios.interceptors.request.use(proxyRequestInterceptor);
    this.axios.interceptors.request.use(userAgentRequestInterceptor);

    if (options.rateLimitOptions) {
      this.axios = rateLimit(this.axios, options.rateLimitOptions);
    }
  }

  public async getImage(
    path: string,
    fallbackPath?: string
  ): Promise<ImageResponse> {
    const cacheKey = this.getCacheKey(path);

    const imageResponse = await this.cached(path, cacheKey);

    if (!imageResponse) {
      const newImage = ImageProxy.isMissing(cacheKey)
        ? null
        : await this.set(path, cacheKey);

      if (!newImage) {
        if (fallbackPath) {
          return await this.getImage(fallbackPath);
        }
        if (ImageProxy.isMissing(cacheKey)) {
          throw new ImageNotFoundError('No such image');
        }
        throw new Error('Failed to load image');
      }

      return newImage;
    }

    return imageResponse;
  }

  /**
   * The cached copy, if there is one, without fetching anything new. A stale
   * copy is still returned, and refreshed in the background.
   */
  public async peek(path: string): Promise<ImageResponse | null> {
    return this.cached(path, this.getCacheKey(path));
  }

  private async cached(
    path: string,
    cacheKey: string
  ): Promise<ImageResponse | null> {
    const imageResponse = await this.get(cacheKey);

    if (imageResponse?.meta.isStale) {
      this.set(path, cacheKey, imageResponse);
    }

    return imageResponse;
  }

  /** Images the upstream said do not exist, until when. */
  private static missing = new Map<string, number>();

  private static isMissing(cacheKey: string) {
    const until = ImageProxy.missing.get(cacheKey);
    if (until === undefined) {
      return false;
    }
    if (until < Date.now()) {
      ImageProxy.missing.delete(cacheKey);
      return false;
    }
    return true;
  }

  public async clearCachedImage(path: string) {
    // find cacheKey
    const cacheKey = this.getCacheKey(path);
    const directory = join(this.getCacheDirectory(), cacheKey);

    try {
      await promises.access(directory);
    } catch (e) {
      if (e.code === 'ENOENT') {
        logger.debug(
          `Cache directory '${cacheKey}' does not exist; nothing to clear.`,
          {
            label: 'Image Cache',
          }
        );
        return;
      } else {
        logger.error('Error checking cache directory existence', {
          label: 'Image Cache',
          message: e.message,
        });
        return;
      }
    }

    try {
      const files = await promises.readdir(directory);

      await promises.rm(directory, { recursive: true });

      logger.debug(`Cleared ${files[0]} from cache 'avatar'`, {
        label: 'Image Cache',
      });
    } catch (e) {
      logger.error('Failed to clear cached image', {
        label: 'Image Cache',
        message: e.message,
      });
    }
  }

  private async get(cacheKey: string): Promise<ImageResponse | null> {
    try {
      const directory = join(this.getCacheDirectory(), cacheKey);
      const files = await promises.readdir(directory);
      const now = Date.now();

      // Only complete entries: a partially written file still carries its
      // temporary name, and serving one would produce a broken image. Names
      // are "maxAge.expireAt.etag.extension", so anything else is skipped.
      const usable = files
        .filter(
          (file) => !file.endsWith('.tmp') && file.split('.').length === 4
        )
        .map((file) => {
          const [maxAgeSt, expireAtSt] = file.split('.');

          return {
            file,
            expireAt: Number(expireAtSt),
            maxAge: Number(maxAgeSt),
          };
        })
        .filter((entry) => Number.isFinite(entry.expireAt))
        // Freshest first, so a leftover older entry never wins.
        .sort((a, b) => b.expireAt - a.expireAt);

      for (const { file, expireAt, maxAge } of usable) {
        const [, , etag, extension] = file.split('.');
        const filePath = join(directory, file);
        const buffer = await promises.readFile(filePath);

        // A zero-length file means the write did not finish; ignore it and
        // let the caller fetch again rather than serving nothing.
        if (!buffer.length) {
          continue;
        }

        ImageProxy.touch(filePath);

        return {
          meta: {
            curRevalidate: maxAge,
            revalidateAfter: maxAge * 1000 + now,
            isStale: now > expireAt,
            etag,
            extension,
            contentType: contentTypeOf(extension),
            cacheKey,
            cacheMiss: false,
            storedAt: expireAt - maxAge * 1000,
            fileName: file,
          },
          imageBuffer: buffer,
        };
      }
    } catch {
      // No files. Treat as empty cache.
    }

    return null;
  }

  /**
   * Fetches in flight, keyed by cache key. Several parts of a page can ask
   * for the same poster at once; without this they race each other writing
   * the same file and some of them fail.
   */
  private static inFlight = new Map<string, Promise<ImageResponse | null>>();

  private async set(
    path: string,
    cacheKey: string,
    previous?: ImageResponse
  ): Promise<ImageResponse | null> {
    const existing = ImageProxy.inFlight.get(cacheKey);

    if (existing) {
      return existing;
    }

    const request = this.fetchAndStore(path, cacheKey, previous)
      .catch((e) => {
        // A rejected entry must not be handed to later callers, and must not
        // become an unhandled rejection when this came from a background
        // revalidation that nobody awaited.
        logger.debug('Image fetch failed', {
          label: 'Image Cache',
          path,
          errorMessage: e instanceof Error ? e.message : String(e),
        });

        return null;
      })
      .finally(() => {
        ImageProxy.inFlight.delete(cacheKey);
      });

    ImageProxy.inFlight.set(cacheKey, request);

    return request;
  }

  private async fetchAndStore(
    path: string,
    cacheKey: string,
    previous?: ImageResponse
  ): Promise<ImageResponse | null> {
    try {
      const directory = join(this.getCacheDirectory(), cacheKey);
      const response = await this.axios.get(path, {
        responseType: 'arraybuffer',
        // A stale copy is checked rather than fetched again: unchanged, the
        // host answers 304 with no body.
        ...(previous
          ? {
              headers: conditionalHeaders(previous.meta),
              validateStatus: (status: number) =>
                (status >= 200 && status < 300) || status === 304,
            }
          : {}),
      });

      if (previous && response.status === 304) {
        return await this.renew(directory, previous, response.headers);
      }

      const buffer = Buffer.from(response.data, 'binary');

      const contentType = String(response.headers['content-type'] || '');

      // Only images are kept and served as images: an error page answered
      // with a 200 would otherwise be cached and handed out as a poster.
      if (!/^image\//i.test(contentType) || !buffer.length) {
        throw new Error(`Not an image (${contentType || 'no type'})`);
      }

      const extension = (mime.getExtension(contentType) || '').replace(
        /[^\w-]/g,
        ''
      );

      const maxAge =
        maxAgeOf(response.headers['cache-control']) || DEFAULT_MAX_AGE_S;
      const expireAt = Date.now() + maxAge * 1000;
      const etag = (response.headers.etag ?? '').replace(/[^\w-]/g, '');

      const fileName = await this.writeToCacheDir(
        directory,
        extension,
        maxAge,
        expireAt,
        buffer,
        etag
      );

      return {
        meta: {
          curRevalidate: maxAge,
          revalidateAfter: expireAt,
          isStale: false,
          etag,
          extension,
          contentType: contentTypeOf(extension),
          cacheKey,
          cacheMiss: true,
          storedAt: expireAt - maxAge * 1000,
          fileName,
        },
        imageBuffer: buffer,
      };
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      if (status === 404 || status === 410) {
        // Not there upstream: remembered for a while rather than asked for
        // on every page that shows it.
        if (ImageProxy.missing.size >= MISSING_LIMIT) {
          ImageProxy.missing.clear();
        }
        ImageProxy.missing.set(cacheKey, Date.now() + MISSING_FOR_MS);
        logger.debug('Image not found upstream', {
          label: 'Image Cache',
          path,
        });
        return null;
      }
      logger.warn('Something went wrong caching image.', {
        label: 'Image Cache',
        errorMessage: e.message,
        path,
      });
      return null;
    }
  }

  /**
   * A stale copy the host says is unchanged: kept, good for as long again,
   * under its new expiry.
   */
  private async renew(
    directory: string,
    previous: ImageResponse,
    headers: Record<string, unknown>
  ): Promise<ImageResponse> {
    const maxAge =
      maxAgeOf(headers['cache-control']) || previous.meta.curRevalidate;
    const expireAt = Date.now() + maxAge * 1000;
    const { etag, extension } = previous.meta;
    const fileName = `${maxAge}.${expireAt}.${etag}.${extension}`;

    await promises.rename(
      join(directory, previous.meta.fileName),
      join(directory, fileName)
    );

    return {
      meta: {
        ...previous.meta,
        curRevalidate: maxAge,
        revalidateAfter: expireAt,
        isStale: false,
        storedAt: expireAt - maxAge * 1000,
        fileName,
      },
      imageBuffer: previous.imageBuffer,
    };
  }

  /**
   * The image in a smaller size or better format, from the cached original
   * (which the caller has already got). Converted once and kept; a request
   * waits a few seconds at most for that, and is otherwise told 'pending'.
   * With convert false, only an already converted copy is used.
   */
  public async getVariant(
    path: string,
    variant: ImageVariant,
    original: ImageResponse,
    { convert }: { convert: boolean }
  ): Promise<VariantResult> {
    const cacheKey = this.getCacheKey(
      `${path}?f=${variant.format}${variant.width ? `&w=${variant.width}` : ''}`
    );
    const source = fingerprint(original.imageBuffer);
    const kept = await this.get(cacheKey);

    // Made from this very original: still good, whatever its expiry says.
    if (kept && kept.meta.etag.startsWith(source)) {
      return { status: 'ready', image: kept };
    }
    if (!/^image\/(jpeg|png|webp)$/.test(original.meta.contentType)) {
      return { status: 'unavailable' };
    }
    if (!convert || !(await loadSharp())) {
      return { status: (await loadSharp()) ? 'pending' : 'unavailable' };
    }

    let conversion = ImageProxy.inFlight.get(cacheKey);
    if (!conversion) {
      if (conversions.queued >= CONVERSIONS_QUEUED_LIMIT) {
        return { status: 'pending' };
      }
      conversion = conversions
        .run(() => this.convert(cacheKey, variant, original, source))
        .catch((e) => {
          logger.warn('Could not convert an image', {
            label: 'Image Cache',
            path,
            variant,
            errorMessage: e instanceof Error ? e.message : String(e),
          });
          return null;
        })
        .finally(() => ImageProxy.inFlight.delete(cacheKey));
      ImageProxy.inFlight.set(cacheKey, conversion);
    }

    let timer: NodeJS.Timeout | undefined;
    const converted = await Promise.race([
      conversion,
      new Promise<'waited'>((resolve) => {
        timer = setTimeout(() => resolve('waited'), CONVERSION_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));

    if (converted === 'waited') {
      return { status: 'pending' };
    }
    return converted
      ? { status: 'ready', image: converted }
      : { status: 'unavailable' };
  }

  private async convert(
    cacheKey: string,
    variant: ImageVariant,
    original: ImageResponse,
    source: string
  ): Promise<ImageResponse> {
    const sharp = (await loadSharp()) as Sharp;
    let image = sharp(original.imageBuffer, { failOn: 'none' });
    if (variant.width) {
      image = image.resize({ width: variant.width, withoutEnlargement: true });
    }
    let buffer =
      variant.format === 'avif'
        ? await image.avif(AVIF_OPTIONS).toBuffer()
        : await image.webp(WEBP_OPTIONS).toBuffer();
    let extension: string = variant.format;

    // Converting a small, already well-compressed picture can make it
    // bigger; then the original is the better copy, at its own size.
    if (!variant.width && buffer.length >= original.imageBuffer.length) {
      buffer = original.imageBuffer;
      extension = original.meta.extension ?? 'jpg';
    }

    const maxAge = original.meta.curRevalidate;
    const expireAt = Date.now() + maxAge * 1000;
    const etag = `${source}${variant.format}${variant.width ?? ''}`;
    const fileName = await this.writeToCacheDir(
      join(this.getCacheDirectory(), cacheKey),
      extension,
      maxAge,
      expireAt,
      buffer,
      etag
    );

    return {
      meta: {
        curRevalidate: maxAge,
        revalidateAfter: expireAt,
        isStale: false,
        etag,
        extension,
        contentType: contentTypeOf(extension),
        cacheKey,
        cacheMiss: true,
        storedAt: expireAt - maxAge * 1000,
        fileName,
      },
      imageBuffer: buffer,
    };
  }

  private async writeToCacheDir(
    dir: string,
    extension: string | null,
    maxAge: number,
    expireAt: number,
    buffer: Buffer,
    etag: string
  ): Promise<string> {
    const name = `${maxAge}.${expireAt}.${etag}.${extension}`;
    const filename = join(dir, name);

    await promises.mkdir(dir, { recursive: true });

    // Write to a temporary name and rename it into place. Clearing the
    // directory first left a window where a concurrent request for the same
    // image found nothing — or had the file it just wrote deleted underneath
    // it — which surfaced as a poster that would not load.
    const temp = `${filename}.${process.pid}.${Date.now()}.tmp`;

    await promises.writeFile(temp, buffer);
    await promises.rename(temp, filename);

    // Drop any superseded entries now that the new one is safely in place.
    try {
      const files = await promises.readdir(dir);

      await Promise.all(
        files
          .filter((file) => file !== name)
          .map((file) =>
            promises.rm(join(dir, file), { force: true }).catch(() => {
              // a concurrent writer may have removed it already
            })
          )
      );
    } catch {
      // Listing failed; the current image is still readable, which is what
      // matters.
    }

    ImageProxy.wrote(buffer.length);

    return name;
  }

  private getCacheKey(path: string) {
    return this.getHash([this.key, this.cacheVersion, path]);
  }

  private getHash(items: (string | number | Buffer)[]) {
    const hash = createHash('sha256');
    for (const item of items) {
      if (typeof item === 'number') hash.update(String(item));
      else {
        hash.update(item);
      }
    }
    // See https://en.wikipedia.org/wiki/Base64#Filenames
    return hash.digest('base64').replace(/\//g, '-');
  }

  private getCacheDirectory() {
    return path.join(baseCacheDirectory, this.key);
  }
}

// Made on first use, once any outgoing proxy is configured.
let tmdbProxy: ImageProxy | undefined;

/** The one TMDB image cache, shared by the route and anything warming it. */
export const tmdbImageProxy = () =>
  (tmdbProxy ??= new ImageProxy('tmdb', 'https://image.tmdb.org', {
    rateLimitOptions: {
      maxRequests: 20,
      maxRPS: 50,
    },
  }));

/**
 * Starts fetching posters into the image cache before the browser asks for
 * them, so they are there, or on their way, when it does. A browser asking
 * while one is still being fetched shares that fetch. Never waited on, and
 * a poster that fails is simply fetched again when asked for.
 */
export const warmTmdbImages = (paths: string[]) => {
  const proxy = tmdbImageProxy();
  for (const path of paths) {
    proxy
      .getImage(path)
      .then((original) =>
        // The AVIF copy too, which current browsers ask for, while the
        // converter has room: what a browser is waiting on comes first.
        conversions.queued < WARM_CONVERSIONS_QUEUED_LIMIT
          ? proxy.getVariant(path, { format: 'avif' }, original, {
              convert: true,
            })
          : undefined
      )
      .catch(() => undefined);
  }
};

export default ImageProxy;
