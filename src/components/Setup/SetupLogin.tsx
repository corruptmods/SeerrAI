import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import PlexLoginButton from '@app/components/Login/PlexLoginButton';
import { plexLoginFailure } from '@app/components/Login/plexLoginFailure';
import JellyfinSetup from '@app/components/Setup/JellyfinSetup';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { MediaServerType } from '@server/constants/server';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';

const messages = defineMessages('components.Setup', {
  welcome: 'Welcome to Seerr AI',
  signinMessage: 'Get started by signing in',
  signin: 'Sign in to your account',
  signinWithJellyfin: 'Enter your Jellyfin details',
  signinWithEmby: 'Enter your Emby details',
  signinWithPlex: 'Enter your Plex details',
  back: 'Go back',
});

interface LoginWithMediaServerProps {
  serverType: MediaServerType;
  onCancel: () => void;
  onComplete: () => void;
}

const SetupLogin: React.FC<LoginWithMediaServerProps> = ({
  serverType,
  onCancel,
  onComplete,
}) => {
  const intl = useIntl();
  const [authToken, setAuthToken] = useState<string | undefined>(undefined);
  const [error, setError] = useState('');
  const [mediaServerType, setMediaServerType] = useState<MediaServerType>(
    MediaServerType.NOT_CONFIGURED
  );
  const { user, revalidate } = useUser();

  // Effect that is triggered when the `authToken` comes back from the Plex OAuth
  // We take the token and attempt to login. If we get a success message, we will
  // ask swr to revalidate the user which _shouid_ come back with a valid user.

  useEffect(() => {
    const login = async () => {
      try {
        const response = await axios.post('/api/v1/auth/plex', {
          authToken: authToken,
        });

        if (response.data?.id) {
          const { data: user } = await axios.get('/api/v1/auth/me');
          revalidate(user, false);
        }
      } catch (e) {
        setError(plexLoginFailure(intl, e));
        setAuthToken(undefined);
      }
    };
    if (authToken && mediaServerType == MediaServerType.PLEX) {
      login();
    }
  }, [authToken, mediaServerType, revalidate, intl]);

  useEffect(() => {
    if (user) {
      onComplete();
    }
  }, [user, mediaServerType, onComplete]);

  return (
    <div className="p-4">
      <div className="mb-2 flex justify-center text-xl font-bold">
        <FormattedMessage {...messages.signin} />
      </div>
      <div className="mb-2 flex justify-center pb-6 text-sm">
        {serverType === MediaServerType.JELLYFIN ? (
          <FormattedMessage {...messages.signinWithJellyfin} />
        ) : serverType === MediaServerType.EMBY ? (
          <FormattedMessage {...messages.signinWithEmby} />
        ) : (
          <FormattedMessage {...messages.signinWithPlex} />
        )}
      </div>
      {serverType === MediaServerType.PLEX && (
        <>
          {error && <Alert type="error" title={error} />}
          <div className="flex justify-center bg-black/30 px-10 py-8">
            <PlexLoginButton
              large
              purpose="setup"
              onAuthToken={(authToken) => {
                setError('');
                setMediaServerType(MediaServerType.PLEX);
                setAuthToken(authToken);
              }}
              onError={setError}
            />
          </div>
          <div className="mt-4">
            <Button buttonType="default" onClick={() => onCancel()}>
              <FormattedMessage {...messages.back} />
            </Button>
          </div>
        </>
      )}
      {serverType === MediaServerType.JELLYFIN && (
        <JellyfinSetup
          revalidate={revalidate}
          serverType={serverType}
          onCancel={onCancel}
        />
      )}
      {serverType === MediaServerType.EMBY && (
        <JellyfinSetup
          revalidate={revalidate}
          serverType={serverType}
          onCancel={onCancel}
        />
      )}
    </div>
  );
};

export default SetupLogin;
