import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { getIntl } from '@server/i18n';
import requestActionMessages, {
  statusChangeText,
} from '@server/lib/notifications/requestActionMessages';
import { Permission } from '@server/lib/permissions';
import {
  requestFingerprint,
  spendActionToken,
  unspendActionToken,
  verifyActionToken,
} from '@server/lib/requestActionTokens';
import { changeRequestStatus } from '@server/lib/requestStatusChange';
import { getSettings } from '@server/lib/settings';
import { addressGroupOf } from '@server/lib/signInLimiter';
import logger from '@server/logger';
import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';

/** The path CSRF protection leaves to the token (middleware/csrf). */
export const REQUEST_ACTION_PATH = '/api/v1/request/action';

/*
 * Counted by address, as nobody is signed in; an IPv6 client by its /64, as
 * the sign-in limits do. Plenty for someone working through a queue of
 * requests, and far too few to try tokens.
 */
export const requestActionLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  keyGenerator: ({ ip }) => `request-action:${addressGroupOf(ip)}`,
  handler: (_req, res) =>
    res
      .status(429)
      .type('text/plain')
      .send(
        getIntl(
          getSettings().notifications.agents.ntfy.options.locale
        ).formatMessage(requestActionMessages.tooManyTries)
      ),
});

/**
 * Approve or Decline pressed on an ntfy notification. The phone has no Seerr
 * AI session: the signed one-time token in the body is the whole credential,
 * and nothing about the caller (cookies included) is used. Everything is
 * checked again now, as days may have passed: the buttons are still on and
 * still act as that account, the account may still manage requests, and the
 * request is still waiting and unchanged. The answer is a short line for ntfy to show.
 */
export const requestAction: RequestHandler = async (req, res) => {
  const ntfy = getSettings().notifications.agents.ntfy;
  const intl = getIntl(ntfy.options.locale);
  const say = (status: number, text: string) =>
    res.status(status).type('text/plain').send(text);
  const expired = () =>
    say(401, intl.formatMessage(requestActionMessages.buttonExpired));

  const claims = verifyActionToken(
    (req.body as { token?: unknown } | undefined)?.token
  );

  if (
    !claims ||
    !ntfy.enabled ||
    !ntfy.options.approvalButtons ||
    claims.userId !== (ntfy.options.approveAsUserId ?? 1)
  ) {
    return expired();
  }

  try {
    const actor = await getRepository(User).findOne({
      where: { id: claims.userId },
    });

    if (!actor?.hasPermission(Permission.MANAGE_REQUESTS)) {
      return say(
        403,
        intl.formatMessage(requestActionMessages.notAllowed, {
          userName: actor?.displayName ?? `#${claims.userId}`,
        })
      );
    }

    let changed = false;
    const change = await changeRequestStatus(
      claims.requestId,
      claims.action,
      actor,
      {
        // Edited since the notification went out: the button was for what
        // it said then, so whoever pressed it should look again.
        beforeChange: async (request) => {
          if (requestFingerprint(request) !== claims.requestState) {
            changed = true;
            return false;
          }
          return spendActionToken(claims);
        },
        onSaveFailed: () => unspendActionToken(claims),
      }
    );

    if (change.outcome === 'stopped') {
      return changed
        ? say(
            409,
            intl.formatMessage(requestActionMessages.requestChanged, {
              applicationTitle: getSettings().main.applicationTitle,
            })
          )
        : expired();
    }

    logger.info(`Request ${claims.action}d from an ntfy notification`, {
      label: 'Notifications',
      requestId: claims.requestId,
      outcome: change.outcome,
      userId: actor.id,
    });

    return say(
      change.outcome === 'done'
        ? 200
        : change.outcome === 'notFound'
          ? 404
          : 409,
      statusChangeText(change, claims.action, actor.displayName, intl)
    );
  } catch (e) {
    logger.error('Could not act on a request from an ntfy notification', {
      label: 'Notifications',
      requestId: claims.requestId,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return say(
      500,
      intl.formatMessage(requestActionMessages.failed, {
        applicationTitle: getSettings().main.applicationTitle,
      })
    );
  }
};
