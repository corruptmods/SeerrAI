import QuickConnectModal from '@app/components/Common/QuickConnectModal';
import defineMessages from '@app/utils/defineMessages';
import { ApiErrorCode } from '@server/constants/error';
import axios, { isAxiosError } from 'axios';
import { useCallback } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Login.JellyfinQuickConnectModal', {
  title: 'Quick Connect',
  subtitle: 'Sign in with Quick Connect',
  instructions: 'Enter this code in your {mediaServerName} app',
  cancel: 'Cancel',
});

interface JellyfinQuickConnectModalProps {
  onClose: () => void;
  onAuthenticated: () => void;
  onError: (error: string) => void;
  mediaServerName: string;
  /** What to say when the account's name is already another's email. */
  existingAccountMessage: string;
}

const JellyfinQuickConnectModal = ({
  onClose,
  onAuthenticated,
  onError,
  mediaServerName,
  existingAccountMessage,
}: JellyfinQuickConnectModalProps) => {
  const intl = useIntl();

  const authenticate = useCallback(
    async (secret: string) => {
      try {
        await axios.post('/api/v1/auth/jellyfin/quickconnect/authenticate', {
          secret,
        });
      } catch (e) {
        // Said in words, not as the server's code for it.
        if (
          isAxiosError(e) &&
          e.response?.data?.message === ApiErrorCode.ExistingAccount
        ) {
          e.response.data.message = existingAccountMessage;
        }
        throw e;
      }
    },
    [existingAccountMessage]
  );

  return (
    <QuickConnectModal
      show
      title={intl.formatMessage(messages.title)}
      subTitle={intl.formatMessage(messages.subtitle)}
      cancelText={intl.formatMessage(messages.cancel)}
      instructionsMessage={intl.formatMessage(messages.instructions, {
        mediaServerName,
      })}
      onCancel={onClose}
      onSuccess={() => {
        onAuthenticated();
        onClose();
      }}
      onError={onError}
      authenticate={authenticate}
    />
  );
};

export default JellyfinQuickConnectModal;
