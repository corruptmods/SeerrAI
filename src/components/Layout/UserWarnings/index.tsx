import { useNotice } from '@app/context/NoticeQueue';
import useLogout from '@app/hooks/useLogout';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  ChevronRightIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

// Loaded on open: its form library is needed only by the few asked for an
// email.
const AddEmailModal = dynamic(
  () => import('@app/components/Login/AddEmailModal'),
  { ssr: false }
);

const messages = defineMessages('components.Layout.UserWarnings', {
  emailRequired: 'An email address is required.',
  emailInvalid: 'Email address is invalid.',
  passwordRequired: 'A password is required.',
  profileIncomplete: 'Profile is incomplete',
  plexSignInExpired: 'Plex sign-in expired',
  plexSignInExpiredDetail:
    'your watchlist has stopped syncing. Tap to sign out, then sign back in with Plex.',
});

const UserWarnings: React.FC = () => {
  const intl = useIntl();
  const { user, revalidate } = useUser();
  const [showEmailModal, setShowEmailModal] = useState(false);
  const logout = useLogout();

  let warningTitle = intl.formatMessage(messages.profileIncomplete);
  let warningText = '';
  let showSetEmail = false;
  let signOut = false;

  for (const warning of user?.warnings ?? []) {
    switch (warning) {
      case 'userEmailRequired':
        warningText = intl.formatMessage(messages.emailRequired);
        showSetEmail = true;
        break;
      // Plex rejected the token, so watchlist sync stopped. Signing in again
      // stores a fresh one; sign-out uses the shared flow so this device's
      // push subscription is removed too.
      case 'plexTokenExpired':
        warningTitle = intl.formatMessage(messages.plexSignInExpired);
        warningText = intl.formatMessage(messages.plexSignInExpiredDetail);
        signOut = true;
        break;
    }
  }

  // Close the add-email dialog if the email gets set elsewhere, or it holds
  // its notice-queue turn with nothing on screen.
  const emailDialogOpen = showEmailModal && showSetEmail;
  useEffect(() => {
    if (showEmailModal && !showSetEmail) {
      setShowEmailModal(false);
    }
  }, [showEmailModal, showSetEmail]);

  // An open dialog stays up whatever the queue says.
  const myTurn = useNotice(
    'accountWarning',
    warningText || emailDialogOpen ? 'show' : 'hide'
  );

  if (!emailDialogOpen && (!warningText || !myTurn)) {
    return null;
  }

  return (
    <>
      {emailDialogOpen && (
        <AddEmailModal
          onClose={() => setShowEmailModal(false)}
          onSave={() => {
            setShowEmailModal(false);
            revalidate();
          }}
        />
      )}
      {warningText && myTurn && (
        <button
          onClick={
            showSetEmail
              ? () => setShowEmailModal(true)
              : signOut
                ? () => logout()
                : undefined
          }
          className="service-error-banner mb-4 w-full cursor-pointer transition duration-300 hover:border-yellow-400 hover:bg-warning/30"
        >
          <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0" />
          <span className="flex-1 text-left">
            <span className="font-bold">{warningTitle}</span>
            {': '}
            {warningText}
          </span>
          <ChevronRightIcon className="h-5 w-5 flex-shrink-0" />
        </button>
      )}
    </>
  );
};

export default UserWarnings;
