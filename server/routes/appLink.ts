import {
  BROWSER_KEY_LIFETIME,
  MAX_API_KEY_NAME_LENGTH,
  MAX_API_KEYS_PER_PERSON,
} from '@server/constants/apiKeys';
import { getRepository } from '@server/datasource';
import UserApiKey from '@server/entity/UserApiKey';
import type { AppLink } from '@server/lib/appLinks';
import {
  appLinkById,
  approveAppLink,
  declineAppLink,
  displayCode,
  endAppLink,
  secondsLeft,
  startAppLink,
  sweepAppLinks,
  waitingAppLink,
} from '@server/lib/appLinks';
import { allowedBrowserOrigin } from '@server/lib/browserApps';
import { expiresAtFor, keySummary, makeKey } from '@server/lib/personalApiKeys';
import { getSettings } from '@server/lib/settings';
import { addressGroupOf } from '@server/lib/signInLimiter';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { perUserRateLimit } from '@server/middleware/perUserRateLimit';
import type { NextFunction, Request } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { In, IsNull, MoreThan, Or } from 'typeorm';

/*
 * Linking a browser app (lib/appLinks, lib/browserApps). The app, on an
 * allowed site, starts a link and shows its code; its person enters the code
 * at /link while signed in and approves; the app collects a key that only
 * works from that kind of site. Keys show with the person's API keys and are
 * revoked there.
 */

const router = Router();

const MOST_APP_NAME_LENGTH = 32;

/** Keys a person sees in their list: their own and browser apps'. */
const LISTED_SCOPE = Or(IsNull(), In(['browser']));

const startLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  keyGenerator: ({ ip }) => `app-link:${addressGroupOf(ip)}`,
  message: { message: 'Too many links started. Try again in a few minutes.' },
});

// An app checks every few seconds for up to ten minutes.
const waitLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 600,
  keyGenerator: ({ ip }) => `app-link-wait:${addressGroupOf(ip)}`,
  message: { message: 'Checking too often. Try again in a few minutes.' },
});

// Codes are guessed nowhere near fast enough to find someone else's.
const codeLimit = perUserRateLimit({ windowMs: 15 * 60 * 1000, limit: 20 });

/** Why a site can't link now, or undefined if it can. */
const refusal = (
  origin: string | undefined
): { status: number; message: string } | undefined => {
  if (!getSettings().network.browserApps.enabled) {
    return {
      status: 403,
      message: 'Browser apps are turned off on this server.',
    };
  }
  if (!allowedBrowserOrigin(origin)) {
    return {
      status: 403,
      message: 'This site isn’t allowed to link with this server.',
    };
  }
  return undefined;
};

/** What an app calls itself, kept short and plain; it's shown as said. */
const appNameFrom = (asked: unknown): string => {
  const name =
    typeof asked === 'string'
      ? asked
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f\u007f]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MOST_APP_NAME_LENGTH)
          .trim()
      : '';
  return name || 'Browser app';
};

const siteOf = (origin: string): string => new URL(origin).host;

/** Deletes the keys of links that ended before their app collected them. */
const sweep = async (): Promise<void> => {
  const uncollected = sweepAppLinks();
  if (uncollected.length) {
    await getRepository(UserApiKey).delete({ id: In(uncollected) });
  }
};

const NO_SUCH_CODE = {
  status: 404,
  message: 'No link has that code. Check it, or start again in the app.',
};

/**
 * The waiting link a signed-in person's code names, for them to approve or
 * decline. Not with a key: a key can't make keys.
 */
const linkForCode = async (
  req: Request,
  next: NextFunction
): Promise<AppLink | undefined> => {
  if (req.authMethod !== 'session') {
    next({
      status: 403,
      message: 'Link apps while signed in, not with an API key.',
    });
    return undefined;
  }
  await sweep();
  const code = (req.body as { code?: unknown }).code;
  const link = typeof code === 'string' ? waitingAppLink(code) : undefined;
  if (!link) {
    next(NO_SUCH_CODE);
    return undefined;
  }
  const refused = refusal(link.origin);
  if (refused) {
    next(refused);
    return undefined;
  }
  return link;
};

/** An app on an allowed site starts a link. No sign-in: it has none yet. */
router.post('/', startLimit, async (req, res, next) => {
  const origin = req.header('Origin');
  const refused = refusal(origin);
  if (refused) {
    return next(refused);
  }
  try {
    await sweep();
    const link = startAppLink(
      appNameFrom((req.body as { app?: unknown } | undefined)?.app),
      origin as string
    );
    if (!link) {
      return next({
        status: 503,
        message: 'Too many apps are linking right now. Try again shortly.',
      });
    }
    const applicationUrl = getSettings().main.applicationUrl.replace(
      /\/+$/,
      ''
    );
    return res.status(201).json({
      code: displayCode(link.code),
      linkId: link.id,
      expiresIn: secondsLeft(link),
      ...(applicationUrl && {
        url: `${applicationUrl}/link?code=${link.code}`,
      }),
    });
  } catch (e) {
    return next({ status: 500, message: e.message });
  }
});

/** A person checks a code before approving it: which app, from which site. */
router.post('/check', isAuthenticated(), codeLimit, async (req, res, next) => {
  try {
    const link = await linkForCode(req, next);
    if (!link) {
      return;
    }
    return res.status(200).json({
      app: link.app,
      site: siteOf(link.origin),
      origin: link.origin,
      expiresIn: secondsLeft(link),
    });
  } catch (e) {
    return next({ status: 500, message: e.message });
  }
});

/** A person approves: a browser key is made, for the app to collect. */
router.post(
  '/approve',
  isAuthenticated(),
  codeLimit,
  async (req, res, next) => {
    try {
      const link = await linkForCode(req, next);
      if (!link) {
        return;
      }
      const user = req.user!;
      const repository = getRepository(UserApiKey);
      const now = new Date();
      const live = await repository.count({
        where: [
          { userId: user.id, scope: LISTED_SCOPE, expiresAt: IsNull() },
          { userId: user.id, scope: LISTED_SCOPE, expiresAt: MoreThan(now) },
        ],
      });
      if (live >= MAX_API_KEYS_PER_PERSON) {
        return next({
          status: 400,
          message: `You can have up to ${MAX_API_KEYS_PER_PERSON} API keys. Revoke one you no longer use first.`,
        });
      }
      let made = makeKey();
      while (await repository.exists({ where: { publicId: made.publicId } })) {
        made = makeKey();
      }
      const saved = await repository.save(
        new UserApiKey({
          userId: user.id,
          publicId: made.publicId,
          secretHash: made.secretHash,
          name: `${link.app} (${siteOf(link.origin)})`.slice(
            0,
            MAX_API_KEY_NAME_LENGTH
          ),
          createdAt: now,
          expiresAt: expiresAtFor(BROWSER_KEY_LIFETIME, now),
          scope: 'browser',
        })
      );
      approveAppLink(link, {
        secret: made.key,
        keyId: saved.id,
        userId: user.id,
      });
      logger.info('Browser app linked', {
        label: 'API Key',
        userId: user.id,
        keyId: saved.id,
        publicId: saved.publicId,
        app: link.app,
        origin: link.origin,
      });
      return res.status(200).json({ key: keySummary(saved) });
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

router.post(
  '/decline',
  isAuthenticated(),
  codeLimit,
  async (req, res, next) => {
    try {
      const link = await linkForCode(req, next);
      if (!link) {
        return;
      }
      declineAppLink(link);
      return res.status(204).send();
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

/**
 * The app waits on its link: waiting, declined, or approved with its key,
 * handed over once. Only from the site that started it.
 */
router.get<{ linkId: string }>(
  '/:linkId',
  waitLimit,
  async (req, res, next) => {
    try {
      await sweep();
      const link = appLinkById(req.params.linkId);
      if (!link || link.origin !== req.header('Origin')) {
        return next({
          status: 404,
          message: 'This link has expired. Start again.',
        });
      }
      const refused = refusal(link.origin);
      if (refused) {
        return next(refused);
      }
      if (link.state === 'waiting') {
        return res
          .status(200)
          .json({ status: 'waiting', expiresIn: secondsLeft(link) });
      }
      endAppLink(link);
      if (link.state === 'declined') {
        return res.status(200).json({ status: 'declined' });
      }
      const key = await getRepository(UserApiKey).findOne({
        where: { id: link.keyId },
      });
      if (!key) {
        // Revoked before the app collected it.
        return next({
          status: 404,
          message: 'This link has expired. Start again.',
        });
      }
      return res.status(200).json({
        status: 'approved',
        apiKey: link.secret,
        expiresAt: key.expiresAt?.toISOString() ?? null,
      });
    } catch (e) {
      return next({ status: 500, message: e.message });
    }
  }
);

export default router;
