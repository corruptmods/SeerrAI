import { COVER_ART_ARCHIVE_URL, COVER_PATH } from '@server/api/coverartarchive';
import { warmCovers, warmTmdbImages } from '@server/lib/imageproxy';
import { getSettings } from '@server/lib/settings';
import type { NextFunction, Request, Response } from 'express';

// The browser requests every poster on a page of titles shortly after receiving
// it. Warming them into the image cache as the page is sent means each is
// fetched from TMDB and converted while the browser renders, so scrolling meets
// posters rather than empty cards. Album pages do the same with covers.

/** The poster size cards request. */
const CARD_POSTER = '/t/p/w300_and_h450_face';
/**
 * One list page. Warming shares TMDB's rate limit with browser requests, so it
 * stays to what the page shows.
 */
const MAX_WARMED = 20;

/** Poster paths in a page of titles' `results`, as cards show them. */
export const posterPathsOf = (body: unknown): string[] => {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) {
    return [];
  }
  const paths: string[] = [];
  for (const result of results) {
    const poster = (result as { posterPath?: unknown } | null)?.posterPath;
    if (typeof poster === 'string' && /^\/[\w-]+\.(jpe?g|png)$/i.test(poster)) {
      paths.push(`${CARD_POSTER}${poster}`);
      if (paths.length >= MAX_WARMED) {
        break;
      }
    }
  }
  return paths;
};

/**
 * Cover paths in a music page: albums in `results`, or a search's `albums`, as
 * the image proxy takes them.
 */
export const coverPathsOf = (body: unknown): string[] => {
  const page = body as { results?: unknown; albums?: unknown } | null;
  const albums = Array.isArray(page?.results)
    ? page.results
    : Array.isArray(page?.albums)
      ? page.albums
      : [];
  const paths: string[] = [];
  for (const album of albums) {
    const url = (album as { coverUrl?: unknown } | null)?.coverUrl;
    const path =
      typeof url === 'string' && url.startsWith(`${COVER_ART_ARCHIVE_URL}/`)
        ? url.slice(COVER_ART_ARCHIVE_URL.length)
        : undefined;
    if (path && COVER_PATH.test(path)) {
      paths.push(path);
      if (paths.length >= MAX_WARMED) {
        break;
      }
    }
  }
  return paths;
};

/** Warms the posters or covers of any page a GET returns. */
const warmPosters = (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET') {
    return next();
  }
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode === 200 && getSettings().main.cacheImages) {
      const paths = posterPathsOf(body);
      const covers = coverPathsOf(body);
      // After the response is sent, never delaying it.
      if (paths.length) {
        setImmediate(() => warmTmdbImages(paths));
      }
      if (covers.length) {
        setImmediate(() => warmCovers(covers));
      }
    }
    return json(body);
  };
  return next();
};

export default warmPosters;
