import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import PreparedEmail, { emailLogoUrl } from '@server/lib/email';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'path';
import isEmail from 'validator/lib/isEmail';

/** How long a confirmation link works. */
const LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const signatureOf = (userId: number, email: string, expires: number): Buffer =>
  createHmac('sha256', getSettings().sessionSecret ?? '')
    .update(`email-confirmation:${userId}:${email.toLowerCase()}:${expires}`)
    .digest();

/** A link token for this user's current email; changing the email voids it. */
export const confirmationToken = (
  user: Pick<User, 'id' | 'email'>,
  now = Date.now()
): string => {
  const expires = now + LINK_LIFETIME_MS;
  return `${user.id}.${expires}.${signatureOf(user.id, user.email, expires).toString('base64url')}`;
};

/**
 * Emails a confirmation link to a user's unconfirmed email. Only with email
 * notifications on and an Application URL for the link; never throws.
 */
export const sendEmailConfirmation = async (
  user: Pick<User, 'id' | 'email' | 'displayName'>
): Promise<void> => {
  const settings = getSettings();
  const { applicationTitle, applicationUrl } = settings.main;
  if (
    !settings.notifications.agents.email.enabled ||
    !applicationUrl ||
    !isEmail(user.email ?? '', { require_tld: false })
  ) {
    return;
  }
  const confirmEmailLink = `${applicationUrl}/api/v1/auth/confirm-email/${confirmationToken(user)}`;
  try {
    await new PreparedEmail(settings.notifications.agents.email).send({
      template: path.join(__dirname, '../templates/email/confirmemail'),
      message: { to: user.email },
      locals: {
        confirmEmailLink,
        applicationUrl,
        applicationTitle,
        logoUrl: emailLogoUrl(),
        recipientName: user.displayName,
        recipientEmail: user.email,
      },
    });
  } catch (e) {
    logger.error('Failed to send email confirmation link', {
      label: 'User Management',
      userId: user.id,
      errorMessage: e.message,
    });
  }
};

/**
 * Confirms the email a link token was made for, if it's still the user's and
 * the link hasn't expired. Whether it did.
 */
export const confirmEmail = async (
  token: string,
  now = Date.now()
): Promise<boolean> => {
  const [id, expiresAt, signature] = token.split('.');
  const userId = Number(id);
  const expires = Number(expiresAt);
  if (
    !Number.isSafeInteger(userId) ||
    !Number.isSafeInteger(expires) ||
    !signature ||
    expires < now
  ) {
    return false;
  }
  const userRepository = getRepository(User);
  const user = await userRepository.findOne({
    select: { id: true, email: true },
    where: { id: userId },
  });
  if (!user) {
    return false;
  }
  const expected = signatureOf(user.id, user.email, expires);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return false;
  }
  await userRepository.update(user.id, { emailVerified: true });
  return true;
};
