import csurf from '@dr.pogodin/csurf';
import { getSettings } from '@server/lib/settings';
import { unlessApiKey } from '@server/middleware/auth';
import { REQUEST_ACTION_PATH } from '@server/routes/requestAction';
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

/**
 * ntfy's Approve and Decline buttons, sent from a phone with no session or
 * cookie: their one-time token is the credential (routes/requestAction), so
 * there is nothing for another site to ride. Exactly this method and path.
 */
const tokenOnly = (method: string, path: string) =>
  method === 'POST' && path === REQUEST_ACTION_PATH;

/**
 * CSRF protection that follows the setting as it is saved: requests are
 * checked, and given a token, only while it is on.
 */
export const csrfWhileOn = (): RequestHandler => {
  const [check, issue] = csrfProtection();
  return (req, res, next) => {
    if (
      !getSettings().network.csrfProtection ||
      tokenOnly(req.method, req.path)
    ) {
      return next();
    }
    check(req, res, (err?: unknown) =>
      err ? next(err) : issue(req, res, next)
    );
  };
};
