import PlexIcon from '@app/assets/services/plex.svg';
import Button from '@app/components/Common/Button';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import { OPTION_BUTTON } from '@app/components/Login/signInOptions';
import usePlexLogin from '@app/hooks/usePlexLogin';
import defineMessages from '@app/utils/defineMessages';
import type { PlexSignInPurpose } from '@app/utils/plexSameTab';
import { Fragment } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';

const messages = defineMessages('components.Login', {
  loginwithapp: 'Login with {appName}',
  signinwithplex: 'Use your Plex account',
});

interface PlexLoginButtonProps {
  onAuthToken: (authToken: string) => void;
  /** Says why signing in did not work; every failure is told here. */
  onError: (message: string) => void;
  isProcessing?: boolean;
  large?: boolean;
  /** What signing in is for: setup, or the sign-in page (the default). */
  purpose?: Extract<PlexSignInPurpose, 'login' | 'setup'>;
}

const PlexLoginButton = ({
  onAuthToken,
  onError,
  isProcessing,
  large,
  purpose = 'login',
}: PlexLoginButtonProps) => {
  const intl = useIntl();
  const { loading, login } = usePlexLogin({ purpose, onAuthToken, onError });

  return (
    <Button
      className={`${OPTION_BUTTON} border-[#cc7b19] bg-[rgba(204,123,25,0.3)] hover:border-[#cc7b19] hover:bg-[rgba(204,123,25,0.7)] disabled:opacity-50 light:bg-[#cc7b19] light:hover:bg-[#b86d14]`}
      onClick={login}
      disabled={loading || isProcessing}
      // The logo stands for the word "Plex", so the name is given in full.
      aria-label={intl.formatMessage(messages.signinwithplex)}
      data-testid="plex-login-button"
    >
      {loading && (
        <div className="absolute right-0 mr-4 h-4 w-4">
          <SmallLoadingSpinner />
        </div>
      )}

      {large ? (
        <FormattedMessage
          {...messages.loginwithapp}
          values={{
            appName: <PlexIcon className="ml-[0.35em] mt-[2px] w-8" />,
          }}
        >
          {(chunks) => (
            <>
              {chunks.map((c, index) =>
                typeof c === 'string' ? (
                  <span key={index}>{c}</span>
                ) : (
                  <Fragment key={index}>{c}</Fragment>
                )
              )}
            </>
          )}
        </FormattedMessage>
      ) : (
        <PlexIcon className="w-8" />
      )}
    </Button>
  );
};

export default PlexLoginButton;
