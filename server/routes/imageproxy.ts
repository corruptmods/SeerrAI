import { COVER_PATH } from '@server/api/coverartarchive';
import type { ImageFormat, ImageWidth } from '@server/constants/images';
import { IMAGE_FORMATS, IMAGE_WIDTHS } from '@server/constants/images';
import { featureEnabled } from '@server/lib/features';
import type { ImageVariant } from '@server/lib/imageproxy';
import ImageProxy, {
  ImageNotFoundError,
  PICTURE_HEADERS,
  etagMatches,
  musicImageProxy,
  tmdbImageProxy,
} from '@server/lib/imageproxy';
import { musicReady } from '@server/lib/music/access';
import { artistImages } from '@server/lib/music/artistImage';
import {
  FANART_PATH,
  MUSIC_IMAGE_CHANGEABLE,
  MUSIC_IMAGE_ORIGINS,
  TADB_PATH,
} from '@server/lib/music/imageSources';
import logger from '@server/logger';
import { MUSIC_NOT_SET_UP, MUSIC_OFF } from '@server/middleware/music';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import type { Store } from 'express-session';
import { createHash } from 'node:crypto';

const router = Router();

let _tvdbImageProxy: ImageProxy;
function initTvdbImageProxy() {
  if (!_tvdbImageProxy) {
    _tvdbImageProxy = new ImageProxy('tvdb', 'https://artworks.thetvdb.com', {
      rateLimitOptions: {
        maxRequests: 20,
        maxRPS: 50,
      },
    });
  }
  return _tvdbImageProxy;
}

interface Source {
  origin: string;
  proxy: () => ImageProxy;
  /** The only paths fetched from this source. */
  path: RegExp;
  /**
   * Whether a picture can change at the same URL, so browsers revalidate once
   * it expires instead of keeping it forever.
   */
  changeable: boolean;
}

const sources: Record<string, Source> = {
  tmdb: {
    origin: 'https://image.tmdb.org',
    proxy: tmdbImageProxy,
    // /t/p/<size, maybe with a filter>/<file>: w300_and_h450_face,
    // w780_filter(duotone,ffffff,bababa), original...
    path: /^\/t\/p\/[\w(),]+\/[\w-]+\.(?:jpe?g|png|svg|webp)$/i,
    changeable: false,
  },
  tvdb: {
    origin: 'https://artworks.thetvdb.com',
    proxy: initTvdbImageProxy,
    path: /^\/banners\/(?:[\w-]+\/)*[\w-]+\.(?:jpe?g|png|webp)$/i,
    changeable: false,
  },
  // Music pictures. The Cover Art Archive redirects to archive.org; the fetch
  // follows.
  caa: {
    origin: MUSIC_IMAGE_ORIGINS.caa,
    proxy: () => musicImageProxy('caa'),
    path: COVER_PATH,
    changeable: MUSIC_IMAGE_CHANGEABLE.caa,
  },
  fanart: {
    origin: MUSIC_IMAGE_ORIGINS.fanart,
    proxy: () => musicImageProxy('fanart'),
    path: FANART_PATH,
    changeable: MUSIC_IMAGE_CHANGEABLE.fanart,
  },
  tadb: {
    origin: MUSIC_IMAGE_ORIGINS.tadb,
    proxy: () => musicImageProxy('tadb'),
    path: TADB_PATH,
    changeable: MUSIC_IMAGE_CHANGEABLE.tadb,
  },
};

/**
 * Artist picture by MusicBrainz id: /artist/<id>, or /artist/<id>/backdrop for
 * the wide one.
 */
const ARTIST_PATH =
  /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/backdrop)?$/;

/**
 * The chosen artist picture is re-decided weekly (see artistImages), so
 * browsers keep it a day.
 */
const ARTIST_PICTURE_KEPT_S = 24 * 60 * 60;

/** Recheck an artist with no picture after this. */
const NO_ARTIST_PICTURE_KEPT_S = 60 * 60;

const isSource = (type: string) =>
  Object.prototype.hasOwnProperty.call(sources, type);

/*
 * Only signed-in users may add images to the cache: the route is public (the
 * sign-in page shows backdrops through it), and otherwise anyone could make the
 * server download unlimited TMDB images to disk. Checked only for uncached
 * images, read-only: the session middleware would write the session back after
 * every image.
 */
let sessions: { store: Store; secret: string } | undefined;

/** Set the session store and secret used to identify the requester. */
export const useSessionForImages = (options: {
  store: Store;
  secret: string;
}) => {
  sessions = options;
};

/** express-session's default cookie name. */
const SESSION_COOKIE = 'connect.sid';

const signedIn = (req: Request) =>
  new Promise<boolean>((resolve) => {
    const raw = (req.cookies as Record<string, string> | undefined)?.[
      SESSION_COOKIE
    ];
    // Signed values only ("s:" prefix): signedCookie returns any other value
    // unchanged, which would trust a bare session id.
    const id =
      sessions && typeof raw === 'string' && raw.startsWith('s:')
        ? cookieParser.signedCookie(raw, sessions.secret)
        : false;
    if (!sessions || !id) {
      resolve(false);
      return;
    }
    sessions.store.get(id, (error, session) =>
      resolve(!error && !!(session as { userId?: number } | null)?.userId)
    );
  });

/**
 * Requested variant: ?f=avif or ?f=webp, optionally with ?w=780 etc. Undefined
 * for the original; null for anything else, which is refused so each image has
 * a small known set of copies.
 */
const variantAsked = (
  query: Request['query']
): ImageVariant | undefined | null => {
  const { f, w, ...rest } = query;
  if (Object.keys(rest).length) {
    return null;
  }
  if (f === undefined) {
    return w === undefined ? undefined : null;
  }
  if (!(IMAGE_FORMATS as readonly unknown[]).includes(f)) {
    return null;
  }
  if (w === undefined) {
    return { format: f as ImageFormat };
  }
  const width = Number(w);
  return (IMAGE_WIDTHS as readonly number[]).includes(width) &&
    String(width) === w
    ? { format: f as ImageFormat, width: width as ImageWidth }
    : null;
};

/**
 * Conversion is costly, so signed-out users (sign-in page backdrops) share a
 * small conversion budget: enough for that page, not enough to load the server.
 */
const SIGNED_OUT_CONVERSIONS = 20;
const SIGNED_OUT_WINDOW_MS = 10 * 60 * 1000;
let signedOutWindow = { startedAt: 0, used: 0 };

const signedOutMayConvert = () => {
  const now = Date.now();
  if (now - signedOutWindow.startedAt > SIGNED_OUT_WINDOW_MS) {
    signedOutWindow = { startedAt: now, used: 0 };
  }
  if (signedOutWindow.used >= SIGNED_OUT_CONVERSIONS) {
    return false;
  }
  signedOutWindow.used += 1;
  return true;
};

/**
 * Serve an image from a source's cache, fetching and storing it for signed-in
 * users, converting when a format or width is requested.
 */
const serve = async (
  req: Request,
  res: Response,
  next: NextFunction,
  source: Source,
  imagePath: string,
  variant: ImageVariant | undefined,
  options: { maxAgeS?: number; isSignedIn?: boolean } = {}
) => {
  const proxy = source.proxy();
  try {
    let imageData = await proxy.peek(imagePath);
    let isSignedIn = options.isSignedIn;

    if (!imageData) {
      // Uncached: fetched and stored for signed-in users; others are redirected
      // upstream.
      isSignedIn ??= await signedIn(req);
      if (!isSignedIn) {
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, `${source.origin}${imagePath}`);
      }
      imageData = await proxy.getImage(imagePath);
    }

    // Most images here never change (TMDB and TVDB give changed pictures new
    // file names), so mark them immutable. Changeable ones get the same
    // max-age, then revalidate.
    let cacheControl =
      options.maxAgeS !== undefined
        ? `public, max-age=${options.maxAgeS}`
        : source.changeable
          ? `public, max-age=${imageData.meta.curRevalidate}`
          : `public, max-age=${imageData.meta.curRevalidate}, immutable`;

    if (variant) {
      // Only signed-in users trigger conversion; others get existing copies
      // plus a small shared budget (see above).
      let result = await proxy.getVariant(imagePath, variant, imageData, {
        convert: false,
      });
      if (
        result.status === 'pending' &&
        ((isSignedIn ?? (await signedIn(req))) || signedOutMayConvert())
      ) {
        result = await proxy.getVariant(imagePath, variant, imageData, {
          convert: true,
        });
      }
      if (result.status === 'ready') {
        imageData = result.image;
      } else if (result.status === 'pending') {
        // Original as a stand-in; don't cache it under this URL, which belongs
        // to the converted copy.
        cacheControl = 'no-store';
      }
    }

    // TMDB sends no ETag; use the image hash.
    const etag = `"${
      imageData.meta.etag ||
      createHash('sha1').update(imageData.imageBuffer).digest('base64url')
    }"`;
    const headers = {
      'Cache-Control': cacheControl,
      ETag: etag,
    };

    if (etagMatches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, headers);
      return res.end();
    }

    res.writeHead(200, {
      ...headers,
      ...PICTURE_HEADERS,
      'Content-Type': imageData.meta.contentType,
      'Content-Length': imageData.imageBuffer.length,
      'OS-Cache-Key': imageData.meta.cacheKey,
      'OS-Cache-Status': imageData.meta.cacheMiss ? 'MISS' : 'HIT',
    });

    res.end(imageData.imageBuffer);
  } catch (e) {
    if (e instanceof ImageNotFoundError) {
      // Don't refetch upstream for a while; the browser shouldn't either.
      res.setHeader(
        'Cache-Control',
        `public, max-age=${Math.round(proxy.missingForMs / 1000)}`
      );
      return next({ status: 404, message: 'No such image.' });
    }
    logger.error('Failed to proxy image', {
      imagePath,
      errorMessage: e.message,
    });
    if (!res.headersSent) {
      return next({ status: 502, message: 'Failed to proxy image.' });
    }
    next(e);
  }
};

/**
 * Artist picture at its own URL so browsers and the service worker cache it
 * like any image; which picture (Lidarr, TheAudioDB or newest album) is decided
 * here. Deciding may call Lidarr, so only for signed-in users with music on.
 */
const artistPicture = async (
  req: Request,
  res: Response,
  next: NextFunction,
  imagePath: string,
  variant: ImageVariant | undefined
) => {
  const [, mbid, backdrop] = ARTIST_PATH.exec(imagePath) ?? [];
  if (!mbid) {
    return next({ status: 400, message: 'Not an image path.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  if (!(await signedIn(req))) {
    return next({ status: 403, message: 'Sign in to see this picture.' });
  }
  if (!featureEnabled('music')) {
    return next(MUSIC_OFF);
  }
  if (!musicReady()) {
    return next(MUSIC_NOT_SET_UP);
  }

  let image;
  try {
    const images = await artistImages(mbid);
    image = backdrop ? images.backdrop : images.photo;
  } catch (e) {
    logger.warn('Could not find an artist’s picture', {
      label: 'Image Cache',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return next({ status: 404, message: 'No picture of this artist.' });
  }
  if (!image) {
    res.setHeader(
      'Cache-Control',
      `public, max-age=${NO_ARTIST_PICTURE_KEPT_S}`
    );
    return next({ status: 404, message: 'No picture of this artist.' });
  }

  res.removeHeader('Cache-Control');
  return serve(req, res, next, sources[image.source], image.path, variant, {
    maxAgeS: ARTIST_PICTURE_KEPT_S,
    isSignedIn: true,
  });
};

router.get<{
  type: string;
  path: string[];
}>('/:type/*path', async (req, res, next) => {
  // Most backdrop URLs in the app have a double slash
  // ("/w1920_and_h800_multi_faces//x.jpg"). TMDB accepts either, so collapse
  // them.
  const imagePath = ('/' + req.params.path.join('/')).replace(/\/{2,}/g, '/');
  const isArtist = req.params.type === 'artist';
  const source = isSource(req.params.type)
    ? sources[req.params.type]
    : undefined;

  if (!source && !isArtist) {
    return next({ status: 400, message: 'Unsupported image type.' });
  }

  // Image files only, in the shapes the app requests.
  if ((source && !source.path.test(imagePath)) || imagePath.includes('..')) {
    logger.debug('Refused an image path', {
      label: 'Image Cache',
      type: req.params.type,
      imagePath,
    });
    return next({ status: 400, message: 'Not an image path.' });
  }

  const variant = variantAsked(req.query);
  if (variant === null) {
    return next({ status: 400, message: 'Unsupported image options.' });
  }

  return source
    ? serve(req, res, next, source, imagePath, variant)
    : artistPicture(req, res, next, imagePath, variant);
});

export default router;
