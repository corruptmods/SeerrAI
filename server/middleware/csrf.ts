import csurf from '@dr.pogodin/csurf';
import { unlessApiKey } from '@server/middleware/auth';
import type { RequestHandler } from 'express';

/**
 * Settings → Network → CSRF Protection: every request that changes
 * something must carry the token the browser was given in the XSRF-TOKEN
 * cookie, so another site can't make a signed-in browser act for it.
 *
 * Requests made with an API key are let through without one: they never
 * use the session cookie (checkUser refuses a wrong key rather than fall
 * back to it, and the session isn't even loaded for them), and another
 * site can't make a browser send an X-Api-Key header.
 */
export const csrfProtection = (secure: boolean): RequestHandler[] => [
  unlessApiKey(
    csurf({
      cookie: {
        httpOnly: true,
        sameSite: true,
        secure,
        key: '_csrf',
        path: '/',
      },
    })
  ),
  unlessApiKey((req, res, next) => {
    res.cookie('XSRF-TOKEN', req.csrfToken(), {
      sameSite: true,
      secure,
    });
    next();
  }),
];
