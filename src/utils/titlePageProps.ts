import { getHostAndPort } from '@app/utils/urlHelper';
import axios from 'axios';
import type { NextPageContext } from 'next';

/**
 * A title page's details for its server render, so a direct visit arrives
 * drawn. None in the browser: tapping through opens the page at once and it
 * fetches them itself, rather than the tap waiting on the server. None either
 * when _app has already answered (a redirect to sign in).
 *
 * Failures throw, so a missing title is the server's error page as before.
 */
export const serverDetails = async <T>(
  ctx: NextPageContext,
  path: string
): Promise<T | undefined> => {
  if (!ctx.req || !ctx.res || ctx.res.headersSent) {
    return undefined;
  }
  const response = await axios.get<T>(
    `http://${getHostAndPort()}/api/v1/${path}`,
    {
      headers: ctx.req.headers.cookie
        ? { cookie: ctx.req.headers.cookie }
        : undefined,
    }
  );
  return response.data;
};

/** One path segment from the page's query. */
export const segment = (value: string | string[] | undefined): string =>
  encodeURIComponent(String(value));
