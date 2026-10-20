import Button from '@app/components/Common/Button';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import { OPTION_BUTTON } from '@app/components/Login/signInOptions';
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

export const passkeyMessages = defineMessages('components.Login', {
  signinwithpasskey: 'Sign in with a passkey',
  passkey: 'Passkey',
  passkeyfailed: 'That passkey could not sign you in.',
});
const messages = passkeyMessages;

interface PasskeyLoginButtonProps {
  onSignedIn: () => void;
  onError: (message: string) => void;
  /**
   * Under "Or sign in with": the button just says "Passkey" (its full
   * "Sign in with a passkey" is what a screen reader says).
   */
  compact?: boolean;
}

/** Only shown where the browser can use passkeys. */
const PasskeyLoginButton = ({
  onSignedIn,
  onError,
  compact,
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
      className={`${OPTION_BUTTON} bg-transparent`}
      onClick={signIn}
      disabled={busy}
      aria-label={
        compact ? intl.formatMessage(messages.signinwithpasskey) : undefined
      }
      data-testid="passkey-login-button"
    >
      {busy && (
        <div className="absolute right-0 mr-4 h-4 w-4">
          <SmallLoadingSpinner />
        </div>
      )}
      <FingerPrintIcon className="shrink-0" />
      <span className="truncate">
        {intl.formatMessage(
          compact ? messages.passkey : messages.signinwithpasskey
        )}
      </span>
    </Button>
  );
};

export default PasskeyLoginButton;
