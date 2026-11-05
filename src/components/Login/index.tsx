import EmbyLogo from '@app/assets/services/emby-icon-only.svg';
import JellyfinLogo from '@app/assets/services/jellyfin-icon.svg';
import PlexLogo from '@app/assets/services/plex.svg';
import Button from '@app/components/Common/Button';
import ImageFader from '@app/components/Common/ImageFader';
import PageTitle from '@app/components/Common/PageTitle';
import LanguagePicker from '@app/components/Layout/LanguagePicker';
import { StackedLogo } from '@app/components/Layout/Sidebar/BrandLogo';
import JellyfinLogin from '@app/components/Login/JellyfinLogin';
import LocalLogin from '@app/components/Login/LocalLogin';
import OidcLoginButton from '@app/components/Login/OidcLoginButton';
import PasskeyLoginButton, {
  passkeyMessages,
} from '@app/components/Login/PasskeyLoginButton';
import PlexLoginButton from '@app/components/Login/PlexLoginButton';
import { plexLoginFailure } from '@app/components/Login/plexLoginFailure';
import {
  OPTION_BUTTON,
  optionColumns,
  spansRow,
} from '@app/components/Login/signInOptions';
import { singleSignOnOutcome } from '@app/components/Login/singleSignOnMessages';
import SafeModeSignInLink from '@app/components/Themes/SafeModeSignInLink';
import { usePasskeySupport } from '@app/hooks/usePasskeys';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { safeRedirect } from '@app/utils/loginRedirect';
import { SERVER_NAMES, signInServers } from '@app/utils/mediaServerAccounts';
import { Transition } from '@headlessui/react';
import { XCircleIcon } from '@heroicons/react/24/solid';
import type {
  JellyfinFamilyKind,
  MediaServerKind,
} from '@server/constants/server';
import { isJellyfinFamily, typeOfKind } from '@server/constants/server';
import axios from 'axios';
import { useRouter } from 'next/dist/client/router';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { CSSTransition, SwitchTransition } from 'react-transition-group';
import useSWR from 'swr';

const messages = defineMessages('components.Login', {
  signin: 'Sign In',
  signinheader: 'Sign in to continue',
  signinwithjellyfin: 'Use your {mediaServerName} account',
  signinwithoverseerr: 'Use your {applicationTitle} account',
  orsigninwith: 'Or sign in with',
});

const SERVER_LOGOS: Record<MediaServerKind, typeof PlexLogo> = {
  plex: PlexLogo,
  jellyfin: JellyfinLogo,
  emby: EmbyLogo,
};

const Login = () => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const { user, revalidate } = useUser();

  const [error, setError] = useState('');
  const [isProcessing, setProcessing] = useState(false);
  const [authToken, setAuthToken] = useState<string | undefined>(undefined);
  const [mediaServerLogin, setMediaServerLogin] = useState(
    settings.currentSettings.mediaServerLogin
  );

  // Exchange the Plex OAuth token for a session, then revalidate the user.
  useEffect(() => {
    const login = async () => {
      setProcessing(true);
      try {
        const response = await axios.post('/api/v1/auth/plex', { authToken });

        if (response.data?.id) {
          revalidate();
        }
      } catch (e) {
        setError(plexLoginFailure(intl, e));
        setAuthToken(undefined);
        setProcessing(false);
      }
    };
    if (authToken) {
      login();
    }
  }, [authToken, revalidate, intl]);

  // Show why a single sign-on provider did not sign them in.
  const oidcProviders = settings.currentSettings.oidcProviders;
  useEffect(() => {
    const outcome = singleSignOnOutcome(intl, router.query, oidcProviders);
    if (outcome) {
      setError(outcome.message);
    }
  }, [intl, router.query, oidcProviders]);

  // Every sign-in method ends by revalidating the user, so all redirect here.
  useEffect(() => {
    if (user) {
      router.push(safeRedirect(router.query.redirect));
    }
  }, [user, router]);

  const { data: backdrops } = useSWR<string[]>('/api/v1/backdrops', {
    refreshInterval: 0,
    refreshWhenHidden: false,
    revalidateOnFocus: false,
  });

  // Primary server first. Plex uses its button; Jellyfin/Emby share one form.
  const servers = signInServers(settings.currentSettings);
  const plexSignIn = servers.includes('plex');
  const formServers = servers.filter(isJellyfinFamily);
  const [formServer, setFormServer] = useState<JellyfinFamilyKind | undefined>(
    formServers[0]
  );
  const shownServer =
    formServer && formServers.includes(formServer)
      ? formServer
      : formServers[0];

  const isJellyfin = !!shownServer;
  const mediaServerLoginRef = useRef<HTMLDivElement>(null);
  const localLoginRef = useRef<HTMLDivElement>(null);
  const showingServerForm =
    isJellyfin && (mediaServerLogin || !settings.currentSettings.localLogin);
  const loginRef = showingServerForm ? mediaServerLoginRef : localLoginRef;

  const loginFormVisible = isJellyfin || settings.currentSettings.localLogin;

  // Under a form, option buttons show short labels (full text in aria-label).
  const compact = loginFormVisible;
  const { supported: passkeysSupported } = usePasskeySupport();

  const serverFormButton = (kind: JellyfinFamilyKind) => {
    const Logo = SERVER_LOGOS[kind];
    return (
      <Button
        data-testid="mediaserver-login-button"
        className={`${OPTION_BUTTON} bg-transparent`}
        aria-label={intl.formatMessage(messages.signinwithjellyfin, {
          mediaServerName: SERVER_NAMES[kind],
        })}
        onClick={() => {
          setFormServer(kind);
          setMediaServerLogin(true);
        }}
      >
        <Logo className="shrink-0" />
        <span className="truncate">{SERVER_NAMES[kind]}</span>
      </Button>
    );
  };

  // Labels drive the column layout.
  const additionalLoginOptions: {
    key: string;
    label: string;
    button: React.ReactNode;
  }[] = [];
  if (plexSignIn) {
    additionalLoginOptions.push({
      key: 'plex',
      label: 'Plex',
      button: (
        <PlexLoginButton
          isProcessing={isProcessing}
          onAuthToken={(authToken) => {
            setError('');
            setAuthToken(authToken);
          }}
          onError={setError}
          large={!compact}
        />
      ),
    });
  }
  formServers
    .filter((kind) => !showingServerForm || kind !== shownServer)
    .forEach((kind) =>
      additionalLoginOptions.push({
        key: kind,
        label: SERVER_NAMES[kind],
        button: serverFormButton(kind),
      })
    );
  oidcProviders.forEach((provider) =>
    additionalLoginOptions.push({
      key: `oidc-${provider.id}`,
      label: provider.name,
      button: (
        <OidcLoginButton
          provider={provider}
          applicationUrl={settings.currentSettings.applicationUrl}
          redirect={safeRedirect(router.query.redirect)}
          compact={compact}
        />
      ),
    })
  );
  if (showingServerForm && settings.currentSettings.localLogin) {
    additionalLoginOptions.push({
      key: 'seerr',
      label: settings.currentSettings.applicationTitle,
      button: (
        <Button
          data-testid="seerr-login-button"
          className={`${OPTION_BUTTON} bg-transparent`}
          aria-label={intl.formatMessage(messages.signinwithoverseerr, {
            applicationTitle: settings.currentSettings.applicationTitle,
          })}
          onClick={() => setMediaServerLogin(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/os_icon.svg" alt="" className="mr-2 h-5 w-5 shrink-0" />
          <span className="truncate">
            {settings.currentSettings.applicationTitle}
          </span>
        </Button>
      ),
    });
  }
  // Any account type can have a passkey.
  if (passkeysSupported) {
    additionalLoginOptions.push({
      key: 'passkey',
      label: intl.formatMessage(passkeyMessages.passkey),
      button: (
        <PasskeyLoginButton
          onSignedIn={() => revalidate()}
          onError={setError}
          compact={compact}
        />
      ),
    });
  }

  return (
    <div
      className="relative flex min-h-screen flex-col bg-gray-900 py-14"
      data-seerr="login"
    >
      <PageTitle title={intl.formatMessage(messages.signin)} />
      <ImageFader
        backgroundImages={
          backdrops?.map(
            (backdrop) => `https://image.tmdb.org/t/p/w1280${backdrop}`
          ) ?? []
        }
      />
      <div className="absolute right-4 top-4 z-50">
        <LanguagePicker />
      </div>
      <div className="relative z-40 mt-10 flex flex-col items-center px-4 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="relative h-48 w-full max-w-full">
          <StackedLogo />
        </div>
      </div>
      <div className="relative z-50 mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div
          className="bg-gray-800/50 shadow light:bg-surface/90 sm:rounded-lg"
          style={{ backdropFilter: 'blur(5px)' }}
        >
          <>
            <Transition
              as="div"
              show={!!error}
              enter="transition-opacity duration-300"
              enterFrom="opacity-0"
              enterTo="opacity-100"
              leave="transition-opacity duration-300"
              leaveFrom="opacity-100"
              leaveTo="opacity-0"
            >
              <div className="mb-4 rounded-md bg-red-600 p-4">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <XCircleIcon className="h-5 w-5 text-red-300" />
                  </div>
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-red-300">
                      {error}
                    </h3>
                  </div>
                </div>
              </div>
            </Transition>
            <div className="px-10 py-8">
              <SwitchTransition mode="out-in">
                <CSSTransition
                  key={showingServerForm ? `ms-${shownServer}` : 'local'}
                  nodeRef={loginRef}
                  timeout={{ enter: 300, exit: 150 }}
                  onEntered={() => {
                    document
                      .querySelector<HTMLInputElement>('#email, #username')
                      ?.focus();
                  }}
                  classNames={{
                    enter: 'opacity-0',
                    enterActive: 'transition-opacity duration-300 opacity-100',
                    exit: 'opacity-100',
                    exitActive: 'transition-opacity duration-150 opacity-0',
                  }}
                >
                  <div ref={loginRef} className="button-container">
                    {showingServerForm && shownServer ? (
                      <JellyfinLogin
                        serverType={typeOfKind(shownServer)}
                        revalidate={revalidate}
                      />
                    ) : (
                      settings.currentSettings.localLogin && (
                        <LocalLogin revalidate={revalidate} />
                      )
                    )}
                  </div>
                </CSSTransition>
              </SwitchTransition>

              {additionalLoginOptions.length > 0 &&
                (loginFormVisible ? (
                  <div className="flex items-center py-5">
                    <div className="flex-grow border-t border-gray-600" />
                    <span className="mx-2 flex-shrink text-sm text-gray-400">
                      {intl.formatMessage(messages.orsigninwith)}
                    </span>
                    <div className="flex-grow border-t border-gray-600" />
                  </div>
                ) : (
                  <h2 className="mb-6 text-center text-lg font-bold text-neutral-200 light:text-strong">
                    {intl.formatMessage(messages.signinheader)}
                  </h2>
                ))}

              <div
                className="grid w-full gap-2 text-sm"
                style={{
                  gridTemplateColumns: compact
                    ? optionColumns(
                        additionalLoginOptions.map((option) => option.label)
                      )
                    : '1fr',
                }}
                data-testid="sign-in-options"
              >
                {additionalLoginOptions.map((option, index) => (
                  <div
                    key={option.key}
                    className={`flex min-w-0 ${
                      spansRow(index, additionalLoginOptions.length)
                        ? 'col-span-full'
                        : ''
                    }`}
                  >
                    {option.button}
                  </div>
                ))}
              </div>
              <SafeModeSignInLink />
            </div>
          </>
        </div>
      </div>
    </div>
  );
};

export default Login;
