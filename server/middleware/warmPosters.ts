import { warmTmdbImages } from '@server/lib/imageproxy';
import { getSettings } from '@server/lib/settings';
import type { NextFunction, Request, Response } from 'express';

/*
 * A page of titles is followed, a moment later, by the browser asking for
 * every poster on it. Starting those posters into the image cache as the
 * page is sent means each is fetched from TMDB and converted while the
 * browser is still drawing the page, so they are there, or nearly, when it
 * asks, and scrolling meets posters rather than empty cards.
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

/** Warms the posters of any page of titles a GET answers with. */
const warmPosters = (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET') {
    return next();
  }
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode === 200 && getSettings().main.cacheImages) {
      const paths = posterPathsOf(body);
      if (paths.length) {
        // After the answer is on its way, never holding it up.
        setImmediate(() => warmTmdbImages(paths));
      }
    }
    return json(body);
  };
  return next();
};

export default warmPosters;
