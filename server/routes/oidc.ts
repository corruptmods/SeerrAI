import type { OidcOutcome } from '@server/constants/oidc';
import type { Correlation, OidcIdentity } from '@server/lib/oidc';
import {
  CORRELATION_COOKIE,
  CORRELATION_TTL_MS,
  accountForSignIn,
  discoveryProblem,
  errorCode,
  failedClaims,
  finishAtProvider,
  linkToAccount,
  openCorrelation,
  problemText,
  startAtProvider,
  usableProvider,
} from '@server/lib/oidc';
import { getSettings } from '@server/lib/settings';
import { startSession } from '@server/lib/signIn';
import { SignInLimiter } from '@server/lib/signInLimiter';
import logger from '@server/logger';
import { loginUrl, safeRedirect } from '@server/utils/safeRedirect';
import type { CookieOptions, Request, Response } from 'express';
import { Router } from 'express';

/*
 * SSO sign-in and account linking. Each is a browser navigation, not an API
 * call: on to the provider, back to the callback, which ends on the sign-in
 * page or Linked Accounts with the outcome (`?sso=`).
 */
const oidcRoutes = Router();

const limiter = new SignInLimiter('oidc');

const LINKED_ACCOUNTS = '/profile/settings/linked-accounts';

/**
 * Correlation cookie: scoped to these routes, sent with the provider's
 * cross-site top-level redirect back (SameSite=Lax allows it), https-only when
 * Seerr is.
 */
const cookieOptions = (req: Request): CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: getSettings().main.applicationUrl.trim().startsWith('https:'),
  path: req.baseUrl || '/',
  maxAge: CORRELATION_TTL_MS,
});

const clearCorrelation = (req: Request, res: Response, path?: string) => {
  const options = cookieOptions(req);
  delete options.maxAge;
  if (path) {
    options.path = path;
  }
  res.clearCookie(CORRELATION_COOKIE, options);
};

/**
 * At sign-out: drops any sign-in or link still waiting on the provider, from
 * the auth router these routes are mounted under (at /oidc).
 */
export const clearOidcInProgress = (req: Request, res: Response): void =>
  clearCorrelation(req, res, `${req.baseUrl}/oidc`);

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string
  );

/**
 * Navigate from the callback with a self-advancing page, not a redirect: the
 * provider's return was cross-site, and a redirect keeps that, so a
 * SameSite=Strict cookie (CSRF protection's own) wouldn't be sent. Also keeps
 * the code in the URL out of the referrer.
 */
const relay = (res: Response, path: string) => {
  const target = escapeHtml(path);
  const title = escapeHtml(getSettings().main.applicationTitle);
  res
    .status(200)
    .set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Type': 'text/html; charset=utf-8',
    })
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${target}"><title>${title}</title></head><body><a href="${target}">${title}</a></body></html>`
    );
};

/** Where a failed sign-in ends. */
const signInFailed = (
  outcome: OidcOutcome,
  providerId: string,
  returnTo = '/'
) => {
  const page = new URL(loginUrl(returnTo), 'http://localhost');
  page.searchParams.set('sso', outcome);
  page.searchParams.set('provider', providerId);
  return page.pathname + page.search;
};

/** Linked Accounts with the linking outcome. */
const linkOutcome = (outcome: OidcOutcome, providerId: string) =>
  `${LINKED_ACCOUNTS}?sso=${outcome}&provider=${encodeURIComponent(providerId)}`;

/**
 * Map a failed code exchange to an outcome: mismatched state, nonce or issuer,
 * or a reused code, means a sign-in started elsewhere or gone stale; anything
 * else is the provider (or its settings here).
 */
const exchangeOutcome = (e: unknown): OidcOutcome => {
  const code = errorCode(e);
  if (
    code === 'OAUTH_INVALID_RESPONSE' ||
    code === 'OAUTH_JWT_CLAIM_COMPARISON_FAILED' ||
    code === 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED'
  ) {
    return 'expired';
  }
  if (
    code === 'OAUTH_RESPONSE_BODY_ERROR' &&
    (e as { error?: unknown }).error === 'invalid_grant'
  ) {
    return 'expired';
  }
  return 'provider';
};

/** Redirect to the provider with the correlation cookie. */
const goToProvider = async (
  req: Request<{ providerId: string }>,
  res: Response,
  { returnTo, userId }: { returnTo: string; userId?: number }
) => {
  const linking = userId !== undefined;
  const provider = usableProvider(req.params.providerId);
  if (!provider) {
    return res.redirect(
      linking
        ? linkOutcome('unavailable', req.params.providerId)
        : signInFailed('unavailable', req.params.providerId, returnTo)
    );
  }

  try {
    const { url, cookie } = await startAtProvider(provider, {
      returnTo,
      userId,
    });
    res.cookie(CORRELATION_COOKIE, cookie, cookieOptions(req));
    res.set('Cache-Control', 'no-store');
    return res.redirect(url.href);
  } catch (e) {
    logger.warn('Could not start single sign-on', {
      label: 'Auth',
      provider: provider.id,
      ip: req.ip,
      problem: problemText(discoveryProblem(e, provider.issuerUrl)),
    });
    return res.redirect(
      linking
        ? linkOutcome('provider', provider.id)
        : signInFailed('provider', provider.id, returnTo)
    );
  }
};

oidcRoutes.get<{ providerId: string }>(
  '/:providerId/sign-in',
  async (req, res) => {
    await goToProvider(req, res, {
      returnTo: safeRedirect(req.query.redirect),
    });
  }
);

// A POST from the page, so following a link elsewhere never starts one.
oidcRoutes.post<{ providerId: string }>(
  '/:providerId/link',
  async (req, res) => {
    // Linking requires being signed in, and only to your own account.
    if (!req.user) {
      return res.redirect(loginUrl(LINKED_ACCOUNTS));
    }
    // Not with an API key: a link is a sign-in method, and a possibly leaked
    // key must not create one for itself.
    if (req.authMethod !== 'session') {
      return res.status(403).json({
        status: 403,
        message:
          'A sign-in provider can only be linked while signed in, not with a key.',
      });
    }
    await goToProvider(req, res, {
      returnTo: LINKED_ACCOUNTS,
      userId: req.user.id,
    });
  }
);

oidcRoutes.get<{ providerId: string }>(
  '/:providerId/callback',
  async (req, res) => {
    const providerId = req.params.providerId;
    const correlation: Correlation | undefined = openCorrelation(
      req.cookies?.[CORRELATION_COOKIE]
    );
    // Single use, whatever happens next.
    clearCorrelation(req, res);

    const linking = correlation?.userId !== undefined;
    const returnTo = safeRedirect(correlation?.returnTo);
    // The failed-attempt limit only counts sign-ins this browser started here
    // with this provider, proven by the genuine cookie. Forged callbacks (no
    // cookie, or another provider's) are refused uncounted, so they can't lock
    // out others sharing an IP, e.g. behind one proxy.
    const started = correlation?.provider === providerId;
    const failed = (
      outcome: OidcOutcome,
      cause?: string,
      details: Record<string, unknown> = {}
    ) => {
      // Counted on arrival; an unavailable provider is nobody's failure.
      if (started && outcome === 'unavailable') {
        limiter.refund(req, providerId);
      }
      logger.warn(
        linking ? 'Single sign-on link refused' : 'Single sign-on refused',
        {
          label: 'Auth',
          provider: providerId,
          ip: req.ip,
          outcome,
          cause,
          ...details,
        }
      );
      return relay(
        res,
        linking
          ? linkOutcome(outcome, providerId)
          : signInFailed(outcome, providerId, returnTo)
      );
    };

    if (started && limiter.reserve(req, providerId)) {
      return relay(
        res,
        linking
          ? linkOutcome('too-many', providerId)
          : signInFailed('too-many', providerId, returnTo)
      );
    }

    const provider = usableProvider(providerId);
    if (!provider) {
      return failed('unavailable');
    }
    // Cookie missing, expired, forged or for another provider: started in
    // another browser or too long ago.
    if (!correlation || correlation.provider !== provider.id) {
      return failed('expired', 'no matching sign-in in progress');
    }
    // Someone else signed in meanwhile (with CSRF protection off the session is
    // sent): the link belongs to the account that asked for it.
    if (linking && req.user && req.user.id !== correlation.userId) {
      return failed('expired', 'signed in as someone else meanwhile');
    }
    if (typeof req.query.error === 'string') {
      return failed('denied', `provider answered ${req.query.error}`);
    }

    const query = new URL(req.originalUrl, 'http://localhost').search;
    let identity: OidcIdentity;
    let claims: Record<string, unknown>;
    let userinfoFailed: unknown;
    try {
      const finished = await finishAtProvider(provider, query, correlation);
      ({ identity, claims, userinfoFailed } = finished);
      if (userinfoFailed) {
        logger.warn('Single sign-on: could not read userinfo', {
          label: 'Auth',
          provider: provider.id,
          problem: errorCode(userinfoFailed),
        });
      }
    } catch (e) {
      return failed(exchangeOutcome(e), errorCode(e) ?? 'exchange failed');
    }

    // Required claims are checked every time: sign-in, new account and linking.
    // Without userinfo some claims the provider only sends there may be
    // missing, so nobody is admitted on partial claims.
    const rules = provider.requiredClaims;
    if (rules.length > 0) {
      if (userinfoFailed) {
        return failed(
          'provider',
          'userinfo, needed to check who may sign in, could not be read'
        );
      }
      // Log only claim names: values are personal (e.g. groups).
      const failing = failedClaims(rules, claims);
      if (failing.length > 0) {
        return failed('not-allowed', 'claims do not meet the rules', {
          failedClaims: failing,
        });
      }
    }

    try {
      if (linking && correlation.userId !== undefined) {
        const result = await linkToAccount(
          provider,
          identity,
          correlation.userId
        );
        if ('refused' in result) {
          return failed(result.refused);
        }
        limiter.clear(req, providerId);
        logger.info('Single sign-on account linked', {
          label: 'Auth',
          provider: provider.id,
          userId: correlation.userId,
        });
        return relay(res, linkOutcome('linked', provider.id));
      }

      const result = await accountForSignIn(provider, identity);
      if ('refused' in result) {
        return failed(result.refused);
      }
      await startSession(req, result.user.id);
      limiter.clear(req, providerId);
      logger.info(
        result.created
          ? 'Single sign-on: new account made'
          : 'Signed in with single sign-on',
        {
          label: 'Auth',
          provider: provider.id,
          userId: result.user.id,
          ip: req.ip,
        }
      );
      return relay(res, returnTo);
    } catch (e) {
      logger.error('Single sign-on failed', {
        label: 'Auth',
        provider: provider.id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return failed('provider');
    }
  }
);

export default oidcRoutes;
