import defineMessages from '@app/utils/defineMessages';
import type { OidcOutcome } from '@server/constants/oidc';
import type { IntlShape } from 'react-intl';

/*
 * What the sign-in page and Linked Accounts say when someone comes back
 * from a single sign-on provider (`?sso=` and `?provider=` in the address).
 */
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
 * What to tell someone back from a provider, from the address they came
 * back to; undefined when they did not come back from one. The provider is
 * named as the sign-in page knows it, else by its id.
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
