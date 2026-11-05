import rateLimit from 'express-rate-limit';

/**
 * A rate limit counted per signed-in user rather than per IP.
 *
 * For signed-in-only routes. Counting by address behind a reverse proxy means
 * trusting the forwarded address, which anyone can set (express-rate-limit
 * refuses that with "trust proxy" on, logging an error each time); the user's
 * account can't be faked.
 */
export const perUserRateLimit = (options: {
  windowMs: number;
  limit: number;
}) =>
  rateLimit({
    ...options,
    keyGenerator: (req) => `user:${req.user?.id ?? 'none'}`,
    // Shaped like every other error response, so the app can show it.
    message: { message: 'Too many requests. Try again in a few minutes.' },
  });
