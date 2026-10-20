import {
  plexFailedMessage,
  plexNotAllowedMessage,
  plexSignInMessage,
} from '@app/components/Login/plexSignInMessages';
import defineMessages from '@app/utils/defineMessages';
import { PlexSignInError } from '@app/utils/plex';
import { ApiErrorCode } from '@server/constants/error';
import type { IntlShape } from 'react-intl';

const messages = defineMessages('components.Login', {
  plexExistingAccount:
    'Another account here already has the email of this Plex account. Sign in with that account, then link Plex from your profile.',
});

/**
 * Why signing in to Seerr with Plex did not work, in plain words: getting
 * the Plex token, or Seerr's answer to it (the sign-in page and setup).
 */
export const plexLoginFailure = (intl: IntlShape, e: unknown): string => {
  if (e instanceof PlexSignInError) {
    return plexSignInMessage(intl, e);
  }
  const response = (
    e as { response?: { status?: number; data?: { message?: string } } }
  )?.response;
  if (response?.data?.message === ApiErrorCode.ExistingAccount) {
    return intl.formatMessage(messages.plexExistingAccount);
  }
  if (response?.status === 403) {
    return plexNotAllowedMessage(intl);
  }
  return plexFailedMessage(intl);
};
