/*
 * Server side of custom CSS (see server/constants/customCss.ts): stylesheet
 * versions and the Content-Security-Policy limiting stylesheet and font
 * sources.
 *
 * The policy doesn't cover images: posters, avatars and logos come from many
 * places (TMDB with the image cache off, Gravatar, media servers), so the
 * check on a user's own CSS is what keeps their images on this server.
 */
import { cssAddresses } from '@server/constants/customCss';
import type { RequestHandler } from 'express';
import { createHash } from 'node:crypto';

/**
 * Short stylesheet hash for its URL, so browsers cache it until it changes.
 * Null when there is none.
 */
export const cssVersion = (css: string | null | undefined): string | null =>
  css ? createHash('sha256').update(css).digest('hex').slice(0, 12) : null;

/**
 * An address as a CSP source: scheme, host and port for http(s), or host and
 * port for a `//` address. Undefined otherwise, this server's paths included.
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
  // URL host and origin are normalized: no spaces, quotes or ';'.
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
 * Sends the policy with each page. Server CSS is read per request so changes
 * apply on the next load; the policy is rebuilt only when it changes.
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
