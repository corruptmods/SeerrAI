import type { RequestHandler } from 'express';

/** The API's base path, as the spec's server URL gives it. */
const API_BASE = '/api/v1';
const BASE_IN_ANY_CASE = /^\/api\/v1(?=[/?#]|$)/i;

const normalized = (url: string): string => {
  const match = BASE_IN_ANY_CASE.exec(url);
  return match && match[0] !== API_BASE
    ? API_BASE + url.slice(match[0].length)
    : url;
};

/**
 * Express routes paths in any case, but the API spec's check for routes it
 * doesn't document only knows its base path as written. Writes the base path
 * as the spec does, so both see the same request.
 */
const apiPathCase: RequestHandler = (req, _res, next) => {
  req.url = normalized(req.url);
  req.originalUrl = normalized(req.originalUrl);
  next();
};

export default apiPathCase;
