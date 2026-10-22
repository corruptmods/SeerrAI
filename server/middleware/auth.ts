import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type {
  Permission,
  PermissionCheckOptions,
} from '@server/lib/permissions';
import type { ApiKeyOutcome } from '@server/lib/personalApiKeys';
import { authenticateApiKey } from '@server/lib/personalApiKeys';
import { getSettings } from '@server/lib/settings';
import type { Request, RequestHandler } from 'express';

/**
 * Whether a request says who it is with an API key: an X-Api-Key header,
 * even an empty one. Keys are only ever read from that header, never from
 * the address. Such a request is the key's alone: it is never answered as
 * whoever's session cookie came with it, and another site can't make a
 * browser send the header, so it needs no CSRF token.
 */
export const sentApiKey = (req: Request): boolean =>
  req.header('X-API-Key') !== undefined;

/** Runs `handler` only for requests that don't use an API key. */
export const unlessApiKey =
  (handler: RequestHandler): RequestHandler =>
  (req, res, next) =>
    sentApiKey(req) ? next() : handler(req, res, next);

export const checkUser: Middleware = async (req, res, next) => {
  const settings = getSettings();
  let user: User | undefined | null;
  const apiKey = req.header('X-API-Key');

  if (apiKey && apiKey === settings.main.apiKey) {
    const userRepository = getRepository(User);

    let userId = 1; // Work on original administrator account

    // If a User ID is provided, we will act on that user's behalf
    if (req.header('X-API-User')) {
      userId = Number(req.header('X-API-User'));
    }

    user = await userRepository.findOne({ where: { id: userId } });
    req.authMethod = 'apiKey';
  } else if (sentApiKey(req)) {
    // Any other key is a personal one or wrong. The key decides who this
    // is, whatever session came with it, and one that is refused is
    // answered here: never served as the session, which would let a request
    // that skipped the CSRF check act as whoever's cookie came along. Some
    // requests pass through here twice (AI Search reads its body after
    // this); the key is checked, counted and logged once.
    const outcome: ApiKeyOutcome = (res.locals.personalKeyOutcome ??=
      await authenticateApiKey(req, apiKey ?? ''));
    if ('status' in outcome) {
      if (outcome.retryAfter) {
        res.set('Retry-After', String(outcome.retryAfter));
      }
      // Siri's shortcut says `say` aloud, so a refused Siri key is heard.
      res.status(outcome.status).json({
        status: outcome.status,
        message: outcome.message,
        ...(req.originalUrl.startsWith('/api/v1/now-playing')
          ? { say: outcome.message }
          : {}),
      });
      return;
    }
    user = outcome.user;
    req.authMethod = 'personalKey';
  } else if (req.session?.userId) {
    const userRepository = getRepository(User);

    user = await userRepository.findOne({
      where: { id: req.session.userId },
    });
    req.authMethod = 'session';
  }

  if (user) {
    req.user = user;
  } else {
    req.authMethod = undefined;
  }

  req.locale = user?.settings?.locale
    ? user.settings.locale
    : settings.main.locale;

  next();
};

export const isAuthenticated = (
  permissions?: Permission | Permission[],
  options?: PermissionCheckOptions
): Middleware => {
  const authMiddleware: Middleware = (req, res, next) => {
    if (!req.user || !req.user.hasPermission(permissions ?? 0, options)) {
      res.status(403).json({
        status: 403,
        error: 'You do not have permission to access this endpoint',
      });
    } else {
      next();
    }
  };
  return authMiddleware;
};
