import { COVER_ART_ARCHIVE_URL, COVER_PATH } from '@server/api/coverartarchive';
import { warmCovers, warmTmdbImages } from '@server/lib/imageproxy';
import { getSettings } from '@server/lib/settings';
import type { NextFunction, Request, Response } from 'express';

/*
 * A page of titles is followed, a moment later, by the browser asking for
 * every poster on it. Starting those posters into the image cache as the
 * page is sent means each is fetched from TMDB and converted while the
 * browser is still drawing the page, so they are there, or nearly, when it
 * asks, and scrolling meets posters rather than empty cards. A page of
 * albums does the same with their covers.
 */

/** The poster size the cards ask for. */
const CARD_POSTER = '/t/p/w300_and_h450_face';
/**
 * One page of a list. Posters share TMDB's rate limit with what the browser
 * asks for, so warming stays to what the page shows.
 */
const MAX_WARMED = 20;

/** The poster paths of a page of titles: its `results`, as cards show them. */
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
 * The cover paths of a page of music: albums in its `results`, or in a
 * search's `albums`, as the image proxy takes them.
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

/** Warms the posters or covers of any page a GET answers with. */
const warmPosters = (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET') {
    return next();
  }
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode === 200 && getSettings().main.cacheImages) {
      const paths = posterPathsOf(body);
      const covers = coverPathsOf(body);
      // After the answer is on its way, never holding it up.
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
