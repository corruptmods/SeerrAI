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
 * Whether a request authenticates with an API key: an X-Api-Key header, even
 * empty. Keys are only read from that header, never the URL. Such a request
 * belongs to the key alone: never answered as whoever's session cookie came
 * along, and since other sites can't make a browser send the header, it needs
 * no CSRF token.
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

    // X-API-User acts on that user's behalf; else the original admin account.
    const apiUser = req.header('X-API-User');
    const userId = apiUser ? Number(apiUser) : 1;

    user = await userRepository.findOne({ where: { id: userId } });
    req.authMethod = 'apiKey';
  } else if (sentApiKey(req)) {
    // Any other key is personal or wrong. The key decides who this is, whatever
    // session came along, and a rejected key is answered here: never served as
    // the session, which would let a request that skipped the CSRF check act as
    // the cookie's owner. Some requests pass through twice (AI Search reads its
    // body after this); the key is checked, counted and logged once.
    const outcome: ApiKeyOutcome = (res.locals.personalKeyOutcome ??=
      await authenticateApiKey(req, apiKey ?? ''));
    if ('status' in outcome) {
      if (outcome.retryAfter) {
        res.set('Retry-After', String(outcome.retryAfter));
      }
      // Siri's shortcut speaks `say`, so a rejected Siri key is heard.
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
