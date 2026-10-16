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
 * Signing in, and linking an account, through a single sign-on provider.
 * Each is a page the browser goes to (not a call the page makes): it goes
 * on to the provider, and the provider sends it back to the callback, which
 * ends on the sign-in page or Linked Accounts with how it went (`?sso=`).
 */
const oidcRoutes = Router();

const limiter = new SignInLimiter('oidc');

const LINKED_ACCOUNTS = '/profile/settings/linked-accounts';

/**
 * The correlation cookie: only sent back to these routes, with the
 * provider's redirect back here (a top-level link from another site, which
 * SameSite=Lax still lets through), and over https only when Seerr is.
 */
const cookieOptions = (req: Request): CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: getSettings().main.applicationUrl.trim().startsWith('https:'),
  path: req.baseUrl || '/',
  maxAge: CORRELATION_TTL_MS,
});

const clearCorrelation = (req: Request, res: Response) => {
  const options = cookieOptions(req);
  delete options.maxAge;
  res.clearCookie(CORRELATION_COOKIE, options);
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string
  );

/**
 * Sends the browser on to a page here from the callback. A page that moves
 * on by itself rather than a redirect: the provider's redirect back was a
 * link from another site, and a redirect would carry that on, so the new
 * session's cookie (SameSite=Strict while CSRF protection is on) would not
 * be sent with the page it lands on. The code in the address is kept from
 * being passed on as the referrer.
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

/** The page a sign-in that did not go through ends on. */
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

/** Linked Accounts, saying how linking went. */
const linkOutcome = (outcome: OidcOutcome, providerId: string) =>
  `${LINKED_ACCOUNTS}?sso=${outcome}&provider=${encodeURIComponent(providerId)}`;

/**
 * What a failed code exchange means for the person: a state, nonce or
 * issuer that does not match, or a code already used, is a sign-in started
 * elsewhere or gone stale; anything else is the provider (or its settings
 * here) at fault.
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

/** Sends the browser to the provider, with the cookie that ties it together. */
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

oidcRoutes.get<{ providerId: string }>(
  '/:providerId/link',
  async (req, res) => {
    // Linking is for someone signed in, to their own account.
    if (!req.user) {
      return res.redirect(loginUrl(LINKED_ACCOUNTS));
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
    // Used once, whatever happens next.
    clearCorrelation(req, res);

    const linking = correlation?.userId !== undefined;
    const returnTo = safeRedirect(correlation?.returnTo);
    // The limit on failed attempts only covers sign-ins this browser
    // started here with this provider: the genuine cookie proves it. A
    // callback anyone can make up (no cookie, or one for another provider)
    // is refused without counting, so it can never hold up other people
    // who share an address, such as everyone behind one proxy.
    const started = correlation?.provider === providerId;
    const failed = (
      outcome: OidcOutcome,
      cause?: string,
      details: Record<string, unknown> = {}
    ) => {
      if (started && outcome !== 'unavailable') {
        limiter.count(req, providerId);
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

    if (started && limiter.retryAfter(req, providerId)) {
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
    // The cookie is missing, out of date, not genuine, or for another
    // provider: started in another browser, or too long ago.
    if (!correlation || correlation.provider !== provider.id) {
      return failed('expired', 'no matching sign-in in progress');
    }
    // Someone else signed in here meanwhile (CSRF protection off sends the
    // session along): the link was for the account that asked for it.
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

    // Who may sign in, checked every time: signing in, a new account and
    // linking alike. Without userinfo the claims may be missing some the
    // provider only sends there, so nobody is let in on half of them.
    const rules = provider.requiredClaims;
    if (rules.length > 0) {
      if (userinfoFailed) {
        return failed(
          'provider',
          'userinfo, needed to check who may sign in, could not be read'
        );
      }
      // Only the names: the values are the person's (their groups, say).
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
