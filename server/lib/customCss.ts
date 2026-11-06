/*
 * Server side of custom CSS (see server/constants/customCss.ts): stylesheet
 * versions, and the pages' Content-Security-Policy. It limits stylesheet and
 * font sources to this server and the hosts Server CSS names, scripts to this
 * server's files and the page's own inline scripts (by a nonce made for each
 * page, which pages/_document puts on them), and framing to this server.
 *
 * The policy doesn't cover images: posters, avatars and logos come from many
 * places (TMDB with the image cache off, Gravatar, media servers), so the
 * check on a user's own CSS is what keeps their images on this server.
 */
import { cssAddresses } from '@server/constants/customCss';
import type { RequestHandler } from 'express';
import { createHash, randomBytes } from 'node:crypto';

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

/** The stylesheet and font sources, given the server's CSS. */
export const styleSources = (serverCss: string): string => {
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
 * The policy for a page with these style sources and script nonce. In
 * development Next.js also evaluates code it loads.
 */
const policyOf = (sources: string, nonce: string, dev: boolean): string =>
  [
    `script-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ''}`,
    sources,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join('; ');

/**
 * Sends the policy with each page, with a new nonce each time. Server CSS is
 * read per request so changes apply on the next load; its sources are worked
 * out again only when it changes.
 */
export const pagePolicy = (
  serverCss: () => string,
  { dev = false }: { dev?: boolean } = {}
): RequestHandler => {
  let last: { css: string; sources: string } | undefined;
  return (_req, res, next) => {
    const css = serverCss();
    if (last?.css !== css) {
      last = { css, sources: styleSources(css) };
    }
    const nonce = randomBytes(16).toString('base64');
    res.setHeader(
      'Content-Security-Policy',
      policyOf(last.sources, nonce, dev)
    );
    // For browsers without frame-ancestors.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  };
};
