/*
 * The server's side of custom CSS (see server/constants/customCss.ts): the
 * version each stylesheet is fetched by, and the Content-Security-Policy
 * that limits where stylesheets and fonts may come from.
 *
 * The policy covers stylesheets and fonts only. Pictures are not limited
 * by it: posters, avatars and logos come from many places (TMDB when the
 * image cache is off, Gravatar, media servers), so it is the check on a
 * person's own CSS that keeps their pictures on this server.
 */
import { cssAddresses } from '@server/constants/customCss';
import type { RequestHandler } from 'express';
import { createHash } from 'node:crypto';

/**
 * A short fingerprint of a stylesheet, which its address carries so a
 * browser can keep it until it changes. Null when there is none.
 */
export const cssVersion = (css: string | null | undefined): string | null =>
  css ? createHash('sha256').update(css).digest('hex').slice(0, 12) : null;

/**
 * Where an address points, as the policy names a place: the scheme, host
 * and port for http and https, or the host and port alone for an address
 * that starts with // (the page's own scheme). Nothing for anything else,
 * this server's own paths included.
 */
const placeOf = (address: string): string | undefined => {
  const relative = address.startsWith('//');
  let url: URL;
  try {
    url = new URL(relative ? `https:${address}` : address);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return undefined;
  }
  // A URL's host and origin are already tidied: no spaces, quotes or ';'.
  return relative ? url.host : url.origin;
};

const unique = (places: (string | undefined)[]): string[] => [
  ...new Set(places.filter((place): place is string => !!place)),
];

/** The Content-Security-Policy for pages, given the server's CSS. */
export const contentSecurityPolicy = (serverCss: string): string => {
  const { imports, others } = cssAddresses(serverCss);
  const stylesheets = unique(imports.map(placeOf));
  // An imported stylesheet's fonts usually come from where it does.
  const fonts = unique([...imports, ...others].map(placeOf));
  return [
    ["style-src 'self' 'unsafe-inline'", ...stylesheets].join(' '),
    ["font-src 'self' data:", ...fonts].join(' '),
  ].join('; ');
};

/**
 * Sends the policy with each page. The server's CSS is read on every
 * request, so a change applies to the next page loaded; the policy is
 * worked out again only when it has changed.
 */
export const stylePolicy = (serverCss: () => string): RequestHandler => {
  let last: { css: string; policy: string } | undefined;
  return (_req, res, next) => {
    const css = serverCss();
    if (last?.css !== css) {
      last = { css, policy: contentSecurityPolicy(css) };
    }
    res.setHeader('Content-Security-Policy', last.policy);
    next();
  };
};
