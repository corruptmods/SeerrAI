import type { ImageFormat, ImageWidth } from '@server/constants/images';
import { IMAGE_FORMATS, IMAGE_WIDTHS } from '@server/constants/images';
import type { ImageVariant } from '@server/lib/imageproxy';
import ImageProxy, {
  ImageNotFoundError,
  tmdbImageProxy,
} from '@server/lib/imageproxy';
import logger from '@server/logger';
import cookieParser from 'cookie-parser';
import type { Request } from 'express';
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

const sources = {
  tmdb: {
    origin: 'https://image.tmdb.org',
    proxy: tmdbImageProxy,
    // /t/p/<size, maybe with a filter>/<file>: w300_and_h450_face,
    // w780_filter(duotone,ffffff,bababa), original...
    path: /^\/t\/p\/[\w(),]+\/[\w-]+\.(?:jpe?g|png|svg|webp)$/i,
  },
  tvdb: {
    origin: 'https://artworks.thetvdb.com',
    proxy: initTvdbImageProxy,
    path: /^\/banners\/(?:[\w-]+\/)*[\w-]+\.(?:jpe?g|png|webp)$/i,
  },
} as const;

/*
 * Whether the request comes from someone signed in. Only they may add new
 * images to the cache: the route is open (the sign-in page shows backdrops
 * through it), and without this anyone could have it download image after
 * image from TMDB onto the server's disk.
 *
 * Looked up only for an image not cached yet, and read-only: the session
 * middleware would also write the session back after every image.
 */
let sessions: { store: Store; secret: string } | undefined;

/** The session store and secret the API uses, to tell who is asking. */
export const useSessionForImages = (options: {
  store: Store;
  secret: string;
}) => {
  sessions = options;
};

/** express-session's cookie, when no other name is configured. */
const SESSION_COOKIE = 'connect.sid';

const signedIn = (req: Request) =>
  new Promise<boolean>((resolve) => {
    const raw = (req.cookies as Record<string, string> | undefined)?.[
      SESSION_COOKIE
    ];
    // Signed values only ("s:" then the signature): signedCookie hands back
    // any other value unchanged, which would take a bare session id on trust.
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
 * The converted copy asked for: ?f=avif or ?f=webp, and with it maybe
 * ?w=780 and the like for a smaller one. Undefined for the original; null
 * for something else, which is refused so each image has a known few copies.
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
 * Converting costs the server real work, so someone signed out (the sign-in
 * page shows backdrops) may only have a few images converted, shared by all
 * of them: enough for that page, not enough to keep the server busy.
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

router.get<{
  type: string;
  path: string[];
}>('/:type/*path', async (req, res, next) => {
  // Most backdrop addresses in the app put a slash between the size and a
  // path that already starts with one ("/w1920_and_h800_multi_faces//x.jpg").
  // TMDB takes either, so they are read as one.
  const imagePath = ('/' + req.params.path.join('/')).replace(/\/{2,}/g, '/');
  const source =
    req.params.type === 'tmdb' || req.params.type === 'tvdb'
      ? sources[req.params.type]
      : undefined;

  if (!source) {
    return next({ status: 400, message: 'Unsupported image type.' });
  }

  // Image files only, in the shapes the app asks for.
  if (!source.path.test(imagePath) || imagePath.includes('..')) {
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

  try {
    const proxy = source.proxy();
    let imageData = await proxy.peek(imagePath);
    let isSignedIn: boolean | undefined;

    if (!imageData) {
      // Not cached: fetched and kept for someone signed in; anyone else is
      // sent to the image where it is.
      isSignedIn = await signedIn(req);
      if (!isSignedIn) {
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, `${source.origin}${imagePath}`);
      }
      imageData = await proxy.getImage(imagePath);
    }

    // Images at these addresses never change (TMDB and TVDB give a changed
    // picture a new file name), so a browser need not even ask again.
    let cacheControl = `public, max-age=${imageData.meta.curRevalidate}, immutable`;

    if (variant) {
      // Converting is for those signed in, as fetching is; anyone else gets
      // copies already made, and a few new ones (see above).
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
        // The original for now, not to be kept under this address: the
        // converted copy is what belongs here once it is made.
        cacheControl = 'no-store';
      }
    }

    // TMDB sends no ETag of its own; the image's own hash stands in.
    const etag = `"${
      imageData.meta.etag ||
      createHash('sha1').update(imageData.imageBuffer).digest('base64url')
    }"`;
    const headers = {
      'Cache-Control': cacheControl,
      ETag: etag,
    };

    // The browser already has this one.
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }

    res.writeHead(200, {
      ...headers,
      'Content-Type': imageData.meta.contentType,
      'Content-Length': imageData.imageBuffer.length,
      'OS-Cache-Key': imageData.meta.cacheKey,
      'OS-Cache-Status': imageData.meta.cacheMiss ? 'MISS' : 'HIT',
    });

    res.end(imageData.imageBuffer);
  } catch (e) {
    if (e instanceof ImageNotFoundError) {
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
});

export default router;
