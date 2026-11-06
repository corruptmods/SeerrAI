import { getSettings } from '@server/lib/settings';
import type { Request, RequestHandler } from 'express';

/**
 * Whether the browser reached Seerr over https: an https connection (as
 * Express sees it, through a trusted proxy), a proxy saying so, or the host
 * and port of an https Application URL. Plain http by any other address (a LAN
 * address, or the same name on another port) is not.
 */
export const reachedOverHttps = (req: Request): boolean => {
  if (req.secure) {
    return true;
  }
  const proto = req.header('X-Forwarded-Proto')?.split(',')[0]?.trim();
  if (proto?.toLowerCase() === 'https') {
    return true;
  }
  const applicationUrl = getSettings().main.applicationUrl?.trim() ?? '';
  let url: URL;
  try {
    url = new URL(applicationUrl);
  } catch {
    return false;
  }
  // Host and port both: the same name on Seerr's own port is plain http.
  const host = req.get('host')?.toLowerCase();
  return url.protocol === 'https:' && !!host && host === url.host.toLowerCase();
};

const withSecure = (cookie: string): string =>
  /;\s*secure\s*(;|$)/i.test(cookie) ? cookie : `${cookie}; Secure`;

/**
 * Marks every cookie Secure when the browser reached Seerr over https, so
 * none of them is ever sent over plain http afterwards.
 */
const secureCookies: RequestHandler = (req, res, next) => {
  if (!reachedOverHttps(req)) {
    return next();
  }
  const setHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: number | string | string[]) =>
    setHeader(
      name,
      name.toLowerCase() === 'set-cookie'
        ? Array.isArray(value)
          ? value.map(withSecure)
          : withSecure(String(value))
        : value
    )) as typeof res.setHeader;
  next();
};

export default secureCookies;
