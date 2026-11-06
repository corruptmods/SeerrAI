import EmbyLogo from '@app/assets/services/emby-icon-only.svg';
import JellyfinLogo from '@app/assets/services/jellyfin-icon.svg';
import PlexLogo from '@app/assets/services/plex.svg';
import Alert from '@app/components/Common/Alert';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import Dropdown from '@app/components/Common/Dropdown';
import PageTitle from '@app/components/Common/PageTitle';
import { singleSignOnOutcome } from '@app/components/Login/singleSignOnMessages';
import LinkJellyfinQuickConnectModal from '@app/components/UserProfile/UserSettings/UserLinkedAccountsSettings/LinkJellyfinQuickConnectModal';
import usePlexLogin from '@app/hooks/usePlexLogin';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { SERVER_NAMES, accountServers } from '@app/utils/mediaServerAccounts';
import { KeyIcon } from '@heroicons/react/24/outline';
import { TrashIcon } from '@heroicons/react/24/solid';
import { oidcApplicationUrl } from '@server/constants/oidc';
import type {
  JellyfinFamilyKind,
  MediaServerKind,
} from '@server/constants/server';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import LinkJellyfinModal from './LinkJellyfinModal';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserLinkedAccountsSettings',
  {
    linkedAccounts: 'Linked Accounts',
    linkedAccountsHint:
      'These external accounts are linked to your {applicationName} account.',
    noLinkedAccounts:
      'You do not have any external accounts linked to your account.',
    noPermissionDescription:
      "You do not have permission to modify this user's linked accounts.",
    plexErrorUnauthorized: 'Unable to connect to Plex using your credentials',
    plexErrorExists: 'This account is already linked to a Plex user',
    plexErrorNoAccess:
      'This Plex account does not have access to the Plex server.',
    errorUnknown: 'An unknown error occurred',
    deleteFailed: 'Unable to delete linked account.',
    notConnected: 'Not connected',
    notAvailable: 'Not available',
    linkAccount: 'Link Account',
  }
);

const SERVER_LOGOS: Record<MediaServerKind, typeof PlexLogo> = {
  plex: PlexLogo,
  jellyfin: JellyfinLogo,
  emby: EmbyLogo,
};

type LinkedAccount = {
  kind: MediaServerKind;
  username: string;
  /** Seerr is connected to this server, so the account can sign in. */
  connected: boolean;
};

/** A linked single sign-on account. */
type ProviderLink = {
  provider: string;
  name: string;
  logoUrl: string;
  username: string | null;
  /** The provider is enabled, so the link can sign in. */
  available: boolean;
};

const UserLinkedAccountsSettings = () => {
  const intl = useIntl();
  const settings = useSettings();
  const router = useRouter();
  const { user: currentUser } = useUser();
  const {
    user,
    hasPermission,
    revalidate: revalidateUser,
  } = useUser({ id: Number(router.query.userId) });
  const { data: passwordInfo } = useSWR<{ hasPassword: boolean }>(
    user ? `/api/v1/user/${user?.id}/settings/password` : null
  );
  const [jellyfinModalKind, setJellyfinModalKind] = useState<
    JellyfinFamilyKind | undefined
  >();
  const [showJellyfinQuickConnectModal, setShowJellyfinQuickConnectModal] =
    useState(false);
  const { data: providerLinks, mutate: revalidateProviderLinks } = useSWR<
    ProviderLink[]
  >(user ? `/api/v1/user/${user.id}/settings/linked-accounts/oidc` : null);
  const [error, setError] = useState<string | null>(null);

  const applicationName = settings.currentSettings.applicationTitle;
  const oidcProviders = settings.currentSettings.oidcProviders;
  // Linking outcome after returning from a provider.
  const providerOutcome = singleSignOnOutcome(
    intl,
    router.query,
    oidcProviders
  );

  const mediaServers = settings.currentSettings.mediaServers;
  const primary = mediaServers.find((server) => server.primary)?.kind;

  // Linked accounts, primary first, including servers no longer connected.
  const accounts: LinkedAccount[] = useMemo(() => {
    if (!user) return [];
    const usernames: Record<MediaServerKind, string | null | undefined> = {
      plex: user.plexUsername,
      jellyfin: user.jellyfinUsername,
      emby: user.embyUsername,
    };
    return accountServers(user).map((kind) => ({
      kind,
      username: usernames[kind] ?? '',
      connected: mediaServers.some((server) => server.kind === kind),
    }));
  }, [user, mediaServers]);

  // Plex sign-in (popup or redirect) yields a token, linked once the user is
  // known.
  const [plexToken, setPlexToken] = useState<string>();
  const plexLogin = usePlexLogin({
    purpose: 'link',
    onAuthToken: (authToken) => {
      setError(null);
      setPlexToken(authToken);
    },
    onError: setError,
  });

  const userId = user?.id;
  useEffect(() => {
    if (!plexToken || !userId) return;
    setPlexToken(undefined);
    const link = async () => {
      try {
        await axios.post(
          `/api/v1/user/${userId}/settings/linked-accounts/plex`,
          { authToken: plexToken }
        );
        await revalidateUser();
      } catch (e) {
        switch (e?.response?.status) {
          case 401:
            setError(intl.formatMessage(messages.plexErrorUnauthorized));
            break;
          case 403:
            setError(intl.formatMessage(messages.plexErrorNoAccess));
            break;
          case 422:
            setError(intl.formatMessage(messages.plexErrorExists));
            break;
          default:
            setError(intl.formatMessage(messages.errorUnknown));
        }
      }
    };
    link();
  }, [plexToken, userId, revalidateUser, intl]);

  // Connected servers and providers not linked yet.
  const linkable = [
    ...mediaServers
      .filter((server) => !accounts.some((a) => a.kind === server.kind))
      .map(({ kind }) => ({
        key: kind,
        name: SERVER_NAMES[kind],
        action: () => {
          if (kind === 'plex') {
            setError(null);
            plexLogin.login();
          } else {
            setJellyfinModalKind(kind);
          }
        },
      })),
    ...oidcProviders
      .filter((p) => !providerLinks?.some((link) => link.provider === p.id))
      .map((p) => ({
        key: `oidc-${p.id}`,
        name: p.name,
        action: () => {
          // A server route that redirects to the provider via the
          // Application URL, so it needs a full page load (a form post), not
          // the router. The CSRF token goes with it when protection is on.
          const form = document.createElement('form');
          form.method = 'post';
          form.action = `${oidcApplicationUrl(
            settings.currentSettings.applicationUrl
          )}/api/v1/auth/oidc/${encodeURIComponent(p.id)}/link`;
          const token = /(?:^|;\s*)XSRF-TOKEN=([^;]*)/.exec(
            document.cookie
          )?.[1];
          if (token) {
            const field = document.createElement('input');
            field.type = 'hidden';
            field.name = '_csrf';
            field.value = decodeURIComponent(token);
            form.appendChild(field);
          }
          document.body.appendChild(form);
          form.submit();
        },
      })),
  ];

  const usableProviderLinks = (providerLinks ?? []).filter(
    (link) => link.available
  );

  /*
   * Mirrors the server: never the owner's primary-server account, nor the
   * owner's Plex account while Plex is connected (Seerr uses it), and only
   * while a password, another connected account or an enabled provider
   * still lets them sign in.
   */
  const mayUnlink = (account: LinkedAccount) =>
    !(
      user?.id === 1 &&
      (account.kind === primary ||
        (account.kind === 'plex' &&
          mediaServers.some((server) => server.kind === 'plex')))
    ) &&
    (!!passwordInfo?.hasPassword ||
      usableProviderLinks.length > 0 ||
      accounts.some((other) => other.kind !== account.kind && other.connected));

  /** Same for a provider link; an unusable one can always go. */
  const mayUnlinkProvider = (link: ProviderLink) =>
    !link.available ||
    !!passwordInfo?.hasPassword ||
    accounts.some((account) => account.connected) ||
    usableProviderLinks.some((other) => other.provider !== link.provider);

  const deleteProviderLink = async (link: ProviderLink) => {
    try {
      await axios.delete(
        `/api/v1/user/${user?.id}/settings/linked-accounts/oidc/${encodeURIComponent(
          link.provider
        )}`
      );
    } catch {
      setError(intl.formatMessage(messages.deleteFailed));
    }

    await revalidateProviderLinks();
  };

  const deleteRequest = async (account: MediaServerKind) => {
    try {
      await axios.delete(
        `/api/v1/user/${user?.id}/settings/linked-accounts/${account}`
      );
    } catch {
      setError(intl.formatMessage(messages.deleteFailed));
    }

    await revalidateUser();
  };

  if (
    currentUser?.id !== user?.id &&
    hasPermission(Permission.ADMIN) &&
    currentUser?.id !== 1
  ) {
    return (
      <>
        <div className="mb-6">
          <h3 className="heading">
            {intl.formatMessage(messages.linkedAccounts)}
          </h3>
        </div>
        <Alert
          title={intl.formatMessage(messages.noPermissionDescription)}
          type="error"
        />
      </>
    );
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.linkedAccounts),
          intl.formatMessage(globalMessages.usersettings),
          user?.displayName,
        ]}
      />
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h3 className="heading">
            {intl.formatMessage(messages.linkedAccounts)}
          </h3>
          <h6 className="description">
            {intl.formatMessage(messages.linkedAccountsHint, {
              applicationName,
            })}
          </h6>
        </div>
        {currentUser?.id === user?.id && !!linkable.length && (
          <div>
            <Dropdown
              text={intl.formatMessage(messages.linkAccount)}
              buttonType="ghost"
            >
              {linkable.map(({ key, name, action }) => (
                <Dropdown.Item key={key} onClick={action}>
                  {name}
                </Dropdown.Item>
              ))}
            </Dropdown>
          </div>
        )}
      </div>
      {error && <Alert title={error} type="error" />}
      {providerOutcome && (
        <Alert
          title={providerOutcome.message}
          type={providerOutcome.outcome === 'linked' ? 'info' : 'error'}
        />
      )}
      {accounts.length || providerLinks?.length ? (
        <ul className="space-y-4">
          {accounts.map((acct) => {
            const Logo = SERVER_LOGOS[acct.kind];
            return (
              <li
                key={acct.kind}
                className="flex items-center gap-4 overflow-hidden rounded-lg bg-gray-800/50 px-4 py-5 shadow ring-1 ring-gray-700 sm:p-6"
              >
                <div className={`w-12 ${acct.connected ? '' : 'opacity-50'}`}>
                  {acct.kind === 'plex' ? (
                    <div className="flex aspect-square h-full items-center justify-center rounded-full bg-neutral-800">
                      <Logo className="service-logo w-9" />
                    </div>
                  ) : (
                    <Logo />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="break-words text-sm font-bold text-gray-300">
                    {SERVER_NAMES[acct.kind]}
                    {!acct.connected && (
                      <span className="ml-2 font-normal text-gray-400">
                        ({intl.formatMessage(messages.notConnected)})
                      </span>
                    )}
                  </div>
                  <div className="break-words text-xl font-semibold text-strong">
                    {acct.username}
                  </div>
                </div>
                <div className="flex-grow" />
                {mayUnlink(acct) && (
                  <ConfirmButton
                    onClick={() => {
                      deleteRequest(acct.kind);
                    }}
                    confirmText={intl.formatMessage(globalMessages.areyousure)}
                  >
                    <TrashIcon />
                    <span>{intl.formatMessage(globalMessages.delete)}</span>
                  </ConfirmButton>
                )}
              </li>
            );
          })}
          {providerLinks?.map((link) => (
            <li
              key={`oidc-${link.provider}`}
              className="flex items-center gap-4 overflow-hidden rounded-lg bg-gray-800/50 px-4 py-5 shadow ring-1 ring-gray-700 sm:p-6"
            >
              <div
                className={`flex aspect-square w-12 items-center justify-center rounded-full bg-neutral-800 ${
                  link.available ? '' : 'opacity-50'
                }`}
              >
                {link.logoUrl ? (
                  // Admin-supplied URL from any host.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={link.logoUrl}
                    alt=""
                    className="h-7 w-7 object-contain"
                  />
                ) : (
                  <KeyIcon className="h-7 w-7 text-gray-300" />
                )}
              </div>
              <div className="min-w-0">
                <div className="break-words text-sm font-bold text-gray-300">
                  {link.name}
                  {!link.available && (
                    <span className="ml-2 font-normal text-gray-400">
                      ({intl.formatMessage(messages.notAvailable)})
                    </span>
                  )}
                </div>
                <div className="break-words text-xl font-semibold text-strong">
                  {link.username}
                </div>
              </div>
              <div className="flex-grow" />
              {mayUnlinkProvider(link) && (
                <ConfirmButton
                  onClick={() => {
                    deleteProviderLink(link);
                  }}
                  confirmText={intl.formatMessage(globalMessages.areyousure)}
                >
                  <TrashIcon />
                  <span>{intl.formatMessage(globalMessages.delete)}</span>
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-4 text-center md:py-12">
          <h3 className="text-lg font-semibold text-gray-400">
            {intl.formatMessage(messages.noLinkedAccounts)}
          </h3>
        </div>
      )}

      <LinkJellyfinModal
        show={!!jellyfinModalKind}
        kind={jellyfinModalKind ?? 'jellyfin'}
        onClose={() => setJellyfinModalKind(undefined)}
        onSave={() => {
          setJellyfinModalKind(undefined);
          revalidateUser();
        }}
        onSwitchToQuickConnect={() => {
          setJellyfinModalKind(undefined);
          setShowJellyfinQuickConnectModal(true);
        }}
      />

      <LinkJellyfinQuickConnectModal
        show={showJellyfinQuickConnectModal}
        onClose={() => setShowJellyfinQuickConnectModal(false)}
        onSave={() => {
          setShowJellyfinQuickConnectModal(false);
          revalidateUser();
        }}
        onSwitchToPassword={() => {
          setShowJellyfinQuickConnectModal(false);
          setJellyfinModalKind('jellyfin');
        }}
      />
    </>
  );
};

export default UserLinkedAccountsSettings;
