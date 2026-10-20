import singleSignOnMessages from '@app/components/Login/singleSignOnMessages';
import defineMessages from '@app/utils/defineMessages';
import type { PlexSignInProblem } from '@app/utils/plex';
import { plexSignInProblemOf } from '@app/utils/plex';
import type { IntlShape } from 'react-intl';

/*
 * What every page that signs in with Plex (the sign-in page, setup, Linked
 * Accounts, connecting Plex in Settings) says when it doesn't work. Where
 * single sign-on already says the same thing about a provider, Plex is
 * named in its words.
 */
const messages = defineMessages('components.Login.PlexSignIn', {
  popup:
    'The Plex sign-in window could not open. Allow pop-ups for this site and try again.',
  closed: 'The Plex window was closed before you signed in. Try again.',
  unreachable:
    'Plex could not be reached. Check your connection and try again.',
});

const PROBLEM_MESSAGES: Record<
  PlexSignInProblem,
  { id: string; defaultMessage: string }
> = {
  popup: messages.popup,
  closed: messages.closed,
  unreachable: messages.unreachable,
  expired: singleSignOnMessages.expired,
  notSignedIn: singleSignOnMessages.denied,
  failed: singleSignOnMessages.provider,
};

/** Why getting a Plex token did not work, in plain words. */
export const plexSignInMessage = (intl: IntlShape, e: unknown): string =>
  intl.formatMessage(PROBLEM_MESSAGES[plexSignInProblemOf(e)], {
    provider: 'Plex',
  });

/** Plex turned someone away: no access to the server, or not let in here. */
export const plexNotAllowedMessage = (intl: IntlShape): string =>
  intl.formatMessage(singleSignOnMessages.notAllowed, { provider: 'Plex' });

/** Signing in with Plex went wrong some other way. */
export const plexFailedMessage = (intl: IntlShape): string =>
  intl.formatMessage(singleSignOnMessages.provider, { provider: 'Plex' });
