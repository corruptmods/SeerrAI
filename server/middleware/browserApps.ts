import { allowedBrowserOrigin } from '@server/lib/browserApps';
import { getSettings } from '@server/lib/settings';
import { sentApiKey } from '@server/middleware/auth';
import type { Request, RequestHandler } from 'express';

/*
 * Cross-site access for browser apps (lib/browserApps), on /api/v1 only.
 *
 * A request from an allowed site gets Access-Control-Allow-Origin when it
 * carries an API key, or is one of the few calls an app makes before it has
 * one. Never Access-Control-Allow-Credentials: cookies stay with this site's
 * own pages. Anything else, and every request while browser apps are off,
 * is answered as before.
 */

/** Calls an app makes before it has a key: nothing in them is private. */
const KEYLESS: { method: string; path: RegExp }[] = [
  { method: 'GET', path: /^\/status$/ },
  { method: 'GET', path: /^\/settings\/public$/ },
  { method: 'POST', path: /^\/auth\/app-link$/ },
  { method: 'GET', path: /^\/auth\/app-link\/[A-Za-z0-9_-]{32}$/ },
];

const keyless = (req: Request): boolean => {
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  return KEYLESS.some(
    (call) => call.method === method && call.path.test(req.path)
  );
};

export const browserAppsCors: RequestHandler = (req, res, next) => {
  if (!getSettings().network.browserApps.enabled) {
    return next();
  }
  // Caches keep answers for each site apart.
  res.vary('Origin');
  const origin = allowedBrowserOrigin(req.header('Origin'));
  if (!origin) {
    return next();
  }
  if (req.method === 'OPTIONS' && req.header('Access-Control-Request-Method')) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
      'Access-Control-Allow-Headers': 'X-Api-Key, Content-Type',
      'Access-Control-Max-Age': '600',
    });
    res.status(204).end();
    return;
  }
  if (sentApiKey(req) || keyless(req)) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      // So an app can wait as long as a refusal asks.
      'Access-Control-Expose-Headers': 'Retry-After',
    });
  }
  next();
};
