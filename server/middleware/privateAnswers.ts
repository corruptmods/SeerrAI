import type { RequestHandler } from 'express';

/**
 * API answers are per person: never kept by a shared cache (a CDN that caches
 * everything), and checked again before a browser reuses one. Routes that
 * may be cached set their own Cache-Control, which replaces this.
 */
const privateAnswers: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-cache');
  next();
};

export default privateAnswers;
