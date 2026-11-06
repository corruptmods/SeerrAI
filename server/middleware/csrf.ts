import csurf from '@dr.pogodin/csurf';
import { unlessApiKey } from '@server/middleware/auth';
import type { RequestHandler } from 'express';

/**
 * Settings → Network → CSRF Protection: every mutating request must carry the
 * token from the XSRF-TOKEN cookie, so other sites can't make a signed-in
 * browser act for them. The cookies are marked Secure whenever the browser is
 * on https (secureCookies), so plain http on a LAN address keeps working.
 *
 * API key requests skip it: they never use the session cookie (checkUser
 * rejects a wrong key rather than falling back, and the session isn't even
 * loaded for them), and other sites can't make a browser send an X-Api-Key
 * header.
 */
export const csrfProtection = (): RequestHandler[] => [
  unlessApiKey(
    csurf({
      cookie: {
        httpOnly: true,
        sameSite: true,
        key: '_csrf',
        path: '/',
      },
    })
  ),
  unlessApiKey((req, res, next) => {
    res.cookie('XSRF-TOKEN', req.csrfToken(), {
      sameSite: true,
    });
    next();
  }),
];
