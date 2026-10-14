import { COVER_PATH } from '@server/api/coverartarchive';
import type { ImageFormat, ImageWidth } from '@server/constants/images';
import { IMAGE_FORMATS, IMAGE_WIDTHS } from '@server/constants/images';
import { featureEnabled } from '@server/lib/features';
import type { ImageVariant } from '@server/lib/imageproxy';
import ImageProxy, {
  ImageNotFoundError,
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
  /** The only paths fetched there. */
  path: RegExp;
  /**
   * Whether a picture can change at the same address, so a browser checks
   * again once it expires rather than keeping it for good.
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
  // Music's pictures. The Cover Art Archive redirects each cover to
  // archive.org, which the fetch follows.
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
 * A picture of an artist, by their MusicBrainz id: /artist/<id>, or
 * /artist/<id>/backdrop for the wide one behind their page.
 */
const ARTIST_PATH =
  /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/backdrop)?$/;

/**
 * Which picture stands for an artist is decided again each week (see
 * artistImages), so a browser keeps the one it has for a day.
 */
const ARTIST_PICTURE_KEPT_S = 24 * 60 * 60;

/** An artist with no picture is asked about again after this. */
const NO_ARTIST_PICTURE_KEPT_S = 60 * 60;

const isSource = (type: string) =>
  Object.prototype.hasOwnProperty.call(sources, type);

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

/**
 * Sends an image from a source's cache: fetched and kept first for someone
 * signed in, converted when a format or width is asked for.
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
      // Not cached: fetched and kept for someone signed in; anyone else is
      // sent to the image where it is.
      isSignedIn ??= await signedIn(req);
      if (!isSignedIn) {
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, `${source.origin}${imagePath}`);
      }
      imageData = await proxy.getImage(imagePath);
    }

    // Most images at these addresses never change (TMDB and TVDB give a
    // changed picture a new file name), so a browser need not even ask
    // again. One that can is kept as long, then checked.
    let cacheControl =
      options.maxAgeS !== undefined
        ? `public, max-age=${options.maxAgeS}`
        : source.changeable
          ? `public, max-age=${imageData.meta.curRevalidate}`
          : `public, max-age=${imageData.meta.curRevalidate}, immutable`;

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
      // Not asked for again upstream for a while; nor by the browser.
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
 * A picture of an artist, served at an address of its own so browsers and
 * the service worker keep it as they keep any other image: which picture
 * that is (from Lidarr, TheAudioDB or their newest album) is decided here.
 * Deciding may ask Lidarr, so it is only done for someone signed in, while
 * music is on.
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
  // Most backdrop addresses in the app put a slash between the size and a
  // path that already starts with one ("/w1920_and_h800_multi_faces//x.jpg").
  // TMDB takes either, so they are read as one.
  const imagePath = ('/' + req.params.path.join('/')).replace(/\/{2,}/g, '/');
  const isArtist = req.params.type === 'artist';
  const source = isSource(req.params.type)
    ? sources[req.params.type]
    : undefined;

  if (!source && !isArtist) {
    return next({ status: 400, message: 'Unsupported image type.' });
  }

  // Image files only, in the shapes the app asks for.
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
