import defineMessages from '@app/utils/defineMessages';
import type { OidcOutcome } from '@server/constants/oidc';
import type { IntlShape } from 'react-intl';

/* Messages for returning from an SSO provider (`?sso=` and `?provider=`). */
const messages = defineMessages('components.Login.SingleSignOn', {
  signInWith: 'Sign in with {provider}',
  unavailable: 'Signing in with {provider} is not available.',
  provider:
    'Something went wrong with {provider}. Try again, or tell an admin if it keeps happening.',
  denied: '{provider} did not sign you in.',
  expired: 'That took too long, or was started in another window. Try again.',
  noAccount:
    'No account is linked to this {provider} account. Sign in another way and link it, or ask an admin.',
  existingAccount:
    'An account here already uses this email. Sign in with it, then link {provider} in your profile.',
  taken: 'This {provider} account is already linked to someone else here.',
  alreadyLinked:
    'You already have a {provider} account linked. Remove it first to link another.',
  notAllowed:
    'Your {provider} account isn’t allowed here. Ask an admin if that’s wrong.',
  tooMany: 'Too many attempts. Try again in a few minutes.',
  linked: '{provider} is linked. You can now sign in with it.',
});

const OUTCOME_MESSAGES: Record<OidcOutcome, keyof typeof messages> = {
  unavailable: 'unavailable',
  provider: 'provider',
  denied: 'denied',
  expired: 'expired',
  'no-account': 'noAccount',
  'existing-account': 'existingAccount',
  taken: 'taken',
  'already-linked': 'alreadyLinked',
  'not-allowed': 'notAllowed',
  'too-many': 'tooMany',
  linked: 'linked',
};

/**
 * Outcome and message for the SSO query params, or undefined without them.
 * Names the provider by its configured name, else its id.
 */
export const singleSignOnOutcome = (
  intl: IntlShape,
  query: { sso?: unknown; provider?: unknown },
  providers: { id: string; name: string }[]
): { outcome: OidcOutcome; message: string } | undefined => {
  const outcome = query.sso as OidcOutcome;
  if (typeof query.sso !== 'string' || !(outcome in OUTCOME_MESSAGES)) {
    return undefined;
  }
  const id = typeof query.provider === 'string' ? query.provider : '';
  const provider = providers.find((p) => p.id === id)?.name ?? id;
  return {
    outcome,
    message: intl.formatMessage(messages[OUTCOME_MESSAGES[outcome]], {
      provider,
    }),
  };
};

export default messages;
