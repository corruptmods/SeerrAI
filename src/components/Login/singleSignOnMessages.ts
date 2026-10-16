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
    'Something went wrong with {provider}. Try again in a moment, and if it keeps happening, tell an admin.',
  denied: '{provider} did not sign you in.',
  expired: 'That took too long, or was started in another window. Try again.',
  noAccount:
    'No account here is linked to this {provider} account. Sign in another way and link {provider} in your profile, or ask an admin for an account.',
  existingAccount:
    'Another account here already has the email of this {provider} account. Sign in with your existing account, then link {provider} in your profile.',
  taken: 'This {provider} account is already linked to someone else here.',
  alreadyLinked:
    'You already have a {provider} account linked. Remove it first to link another.',
  notAllowed:
    "Your {provider} account isn't allowed to use this server. Ask an admin if you think it should be.",
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
