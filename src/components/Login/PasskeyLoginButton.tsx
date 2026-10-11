import Button from '@app/components/Common/Button';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import {
  isCancelled,
  preloadPasskeys,
  signInWithPasskey,
  usePasskeySupport,
} from '@app/hooks/usePasskeys';
import defineMessages from '@app/utils/defineMessages';
import { FingerPrintIcon } from '@heroicons/react/24/outline';
import { isAxiosError } from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Login', {
  signinwithpasskey: 'Sign in with a passkey',
  passkeyfailed: 'That passkey could not sign you in.',
});

interface PasskeyLoginButtonProps {
  onSignedIn: () => void;
  onError: (message: string) => void;
}

/** Only shown where the browser can use passkeys. */
const PasskeyLoginButton = ({
  onSignedIn,
  onError,
}: PasskeyLoginButtonProps) => {
  const intl = useIntl();
  const { supported } = usePasskeySupport();
  useEffect(() => {
    if (supported) {
      preloadPasskeys();
    }
  }, [supported]);
  const [busy, setBusy] = useState(false);

  if (!supported) {
    return null;
  }

  const signIn = async () => {
    setBusy(true);
    onError('');
    try {
      await signInWithPasskey();
      onSignedIn();
    } catch (e) {
      if (!isCancelled(e)) {
        onError(
          (isAxiosError(e) && e.response?.data?.message) ||
            intl.formatMessage(messages.passkeyfailed)
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      className="relative flex-1 bg-transparent"
      onClick={signIn}
      disabled={busy}
      data-testid="passkey-login-button"
    >
      {busy && (
        <div className="absolute right-0 mr-4 h-4 w-4">
          <SmallLoadingSpinner />
        </div>
      )}
      <FingerPrintIcon />
      <span>{intl.formatMessage(messages.signinwithpasskey)}</span>
    </Button>
  );
};

export default PasskeyLoginButton;
