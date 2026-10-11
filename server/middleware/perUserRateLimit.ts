import rateLimit from 'express-rate-limit';

/**
 * A rate limit counted per signed-in person rather than per IP address.
 *
 * For routes only signed-in people reach. Counting by address behind a
 * reverse proxy means trusting the forwarded address, which anyone can set
 * (express-rate-limit refuses to count that way with "trust proxy" on, and
 * logs an error each time); the person's account cannot be faked.
 */
export const perUserRateLimit = (options: {
  windowMs: number;
  limit: number;
}) =>
  rateLimit({
    ...options,
    keyGenerator: (req) => `user:${req.user?.id ?? 'none'}`,
  });
