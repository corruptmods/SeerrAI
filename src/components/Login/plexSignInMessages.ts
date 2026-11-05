import singleSignOnMessages from '@app/components/Login/singleSignOnMessages';
import defineMessages from '@app/utils/defineMessages';
import type { PlexSignInProblem } from '@app/utils/plex';
import { plexSignInProblemOf } from '@app/utils/plex';
import type { IntlShape } from 'react-intl';

/*
 * Plex sign-in failure messages for every page that signs in with Plex.
 * Reuses the single sign-on wording where it already fits.
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

/** Message for a failed Plex token request. */
export const plexSignInMessage = (intl: IntlShape, e: unknown): string =>
  intl.formatMessage(PROBLEM_MESSAGES[plexSignInProblemOf(e)], {
    provider: 'Plex',
  });

/** Message for a Plex user without access to the server or not allowed here. */
export const plexNotAllowedMessage = (intl: IntlShape): string =>
  intl.formatMessage(singleSignOnMessages.notAllowed, { provider: 'Plex' });

/** Message for any other Plex sign-in failure. */
export const plexFailedMessage = (intl: IntlShape): string =>
  intl.formatMessage(singleSignOnMessages.provider, { provider: 'Plex' });
