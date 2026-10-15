import EmbyLogo from '@app/assets/services/emby-icon-only.svg';
import JellyfinLogo from '@app/assets/services/jellyfin-icon.svg';
import PlexLogo from '@app/assets/services/plex.svg';
import Alert from '@app/components/Common/Alert';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import Dropdown from '@app/components/Common/Dropdown';
import PageTitle from '@app/components/Common/PageTitle';
import { singleSignOnOutcome } from '@app/components/Login/singleSignOnMessages';
import LinkJellyfinQuickConnectModal from '@app/components/UserProfile/UserSettings/UserLinkedAccountsSettings/LinkJellyfinQuickConnectModal';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { SERVER_NAMES, accountServers } from '@app/utils/mediaServerAccounts';
import PlexOAuth from '@app/utils/plex';
import { KeyIcon } from '@heroicons/react/24/outline';
import { TrashIcon } from '@heroicons/react/24/solid';
import { oidcApplicationUrl } from '@server/constants/oidc';
import type {
  JellyfinFamilyKind,
  MediaServerKind,
} from '@server/constants/server';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
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

const plexOAuth = new PlexOAuth();

const SERVER_LOGOS: Record<MediaServerKind, typeof PlexLogo> = {
  plex: PlexLogo,
  jellyfin: JellyfinLogo,
  emby: EmbyLogo,
};

type LinkedAccount = {
  kind: MediaServerKind;
  username: string;
  /** Seerr is connected to this server; the account is used to sign in. */
  connected: boolean;
};

/** An account on a single sign-on provider, linked here. */
type ProviderLink = {
  provider: string;
  name: string;
  logoUrl: string;
  username: string | null;
  /** The provider is switched on: the link can be used to sign in. */
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
  // Back from a single sign-on provider: how linking went.
  const providerOutcome = singleSignOnOutcome(
    intl,
    router.query,
    oidcProviders
  );

  const mediaServers = settings.currentSettings.mediaServers;
  const primary = mediaServers.find((server) => server.primary)?.kind;

  // Every account they have linked, their main one first, including any on
  // a server Seerr is no longer connected to.
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

  const linkPlexAccount = async () => {
    setError(null);
    try {
      const authToken = await plexOAuth.login(
        settings.currentSettings.plexClientIdentifier
      );
      await axios.post(
        `/api/v1/user/${user?.id}/settings/linked-accounts/plex`,
        {
          authToken,
        }
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

  // Each connected server, and each single sign-on provider, they have no
  // account linked from yet. A provider is linked by signing in there, by
  // way of the Application URL it sends people back to.
  const linkable = [
    ...mediaServers
      .filter((server) => !accounts.some((a) => a.kind === server.kind))
      .map(({ kind }) => ({
        key: kind,
        name: SERVER_NAMES[kind],
        action: () => {
          if (kind === 'plex') {
            plexOAuth.preparePopup();
            setTimeout(() => linkPlexAccount(), 1500);
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
          // Not a page here but a route the server answers by sending the
          // browser on to the provider, by way of the Application URL it
          // comes back to: a full page load, which the router can't do.
          const start = `${oidcApplicationUrl(
            settings.currentSettings.applicationUrl
          )}/api/v1/auth/oidc/${encodeURIComponent(p.id)}/link`;
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign(start);
        },
      })),
  ];

  const usableProviderLinks = (providerLinks ?? []).filter(
    (link) => link.available
  );

  /*
   * Whether an account can be unlinked, as the server decides: never the
   * owner's account on the primary server, nor the owner's Plex account
   * while Plex is connected (Seerr reaches Plex with it), and only while a
   * password, another account on a connected server, or a single sign-on
   * provider that is switched on still lets them in.
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

  /** The same for a provider link; one that can't be used can always go. */
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
                      <Logo className="w-9" />
                    </div>
                  ) : (
                    <Logo />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold text-gray-300">
                    {SERVER_NAMES[acct.kind]}
                    {!acct.connected && (
                      <span className="ml-2 font-normal text-gray-400">
                        ({intl.formatMessage(messages.notConnected)})
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xl font-semibold text-white">
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
                  // A picture the admin chose, from wherever it is kept.
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
                <div className="truncate text-sm font-bold text-gray-300">
                  {link.name}
                  {!link.available && (
                    <span className="ml-2 font-normal text-gray-400">
                      ({intl.formatMessage(messages.notAvailable)})
                    </span>
                  )}
                </div>
                <div className="truncate text-xl font-semibold text-white">
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
