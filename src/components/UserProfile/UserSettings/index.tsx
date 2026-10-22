import Alert from '@app/components/Common/Alert';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import type { SettingsRoute } from '@app/components/Common/SettingsTabs';
import SettingsTabs from '@app/components/Common/SettingsTabs';
import ProfileHeader from '@app/components/UserProfile/ProfileHeader';
import useFeature from '@app/hooks/useFeature';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { UserSettingsNotificationsResponse } from '@server/interfaces/api/userSettingsInterfaces';
import { hasPermission, Permission } from '@server/lib/permissions';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.UserProfile.UserSettings', {
  menuGeneralSettings: 'General',
  menuFeatures: 'Features',
  menuAppearance: 'Appearance',
  menuChangePass: 'Password',
  menuLinkedAccounts: 'Linked Accounts',
  menuPasskeys: 'Passkeys',
  menuApiKeys: 'API Keys',
  menuSiri: 'Siri',
  menuNotifications: 'Notifications',
  menuPermissions: 'Permissions',
  unauthorizedDescription:
    "You do not have permission to modify this user's settings.",
});

type UserSettingsProps = {
  children: React.ReactNode;
};

const UserSettings = ({ children }: UserSettingsProps) => {
  const router = useRouter();
  const settings = useSettings();
  const { user: currentUser } = useUser();
  const { user, error } = useUser({ id: Number(router.query.userId) });
  const intl = useIntl();
  const siriOn = useFeature('siri');
  const { data } = useSWR<UserSettingsNotificationsResponse>(
    user ? `/api/v1/user/${user?.id}/settings/notifications` : null
  );

  if (!user && !error) {
    return <LoadingSpinner />;
  }

  if (!user) {
    return <ErrorPage statusCode={500} />;
  }

  const settingsRoutes: SettingsRoute[] = [
    {
      text: intl.formatMessage(messages.menuGeneralSettings),
      route: '/settings/main',
      regex: /\/settings(\/main)?$/,
    },
    {
      text: intl.formatMessage(messages.menuFeatures),
      route: '/settings/features',
      regex: /\/settings\/features/,
    },
    {
      text: intl.formatMessage(messages.menuAppearance),
      route: '/settings/appearance',
      regex: /\/settings\/appearance/,
    },
    {
      text: intl.formatMessage(messages.menuChangePass),
      route: '/settings/password',
      regex: /\/settings\/password/,
      hidden:
        (!settings.currentSettings.localLogin &&
          !hasPermission(Permission.ADMIN, currentUser?.permissions ?? 0)) ||
        (currentUser?.id !== 1 &&
          currentUser?.id !== user?.id &&
          hasPermission(Permission.ADMIN, user?.permissions ?? 0)),
    },
    {
      text: intl.formatMessage(messages.menuLinkedAccounts),
      route: '/settings/linked-accounts',
      regex: /\/settings\/linked-accounts/,
    },
    {
      text: intl.formatMessage(messages.menuPasskeys),
      route: '/settings/passkeys',
      regex: /\/settings\/passkeys/,
      // Managed by the person it signs in. Someone who manages users can
      // also remove one, except the owner's or another admin's.
      hidden:
        currentUser?.id !== user.id &&
        (!hasPermission(
          Permission.MANAGE_USERS,
          currentUser?.permissions ?? 0
        ) ||
          (currentUser?.id !== 1 &&
            (user.id === 1 ||
              hasPermission(Permission.ADMIN, user.permissions ?? 0)))),
    },
    {
      text: intl.formatMessage(messages.menuApiKeys),
      route: '/settings/api-keys',
      regex: /\/settings\/api-keys/,
      // Your own, once an admin lets you make them. Someone who manages
      // users sees another person's while keys are on, except the owner's
      // or another admin's.
      hidden:
        settings.currentSettings.personalApiKeys === 'off' ||
        (currentUser?.id === user.id
          ? settings.currentSettings.personalApiKeys === 'managers' &&
            !hasPermission(
              Permission.MANAGE_USERS,
              currentUser?.permissions ?? 0
            )
          : !hasPermission(
              Permission.MANAGE_USERS,
              currentUser?.permissions ?? 0
            ) ||
            (currentUser?.id !== 1 &&
              (user.id === 1 ||
                hasPermission(Permission.ADMIN, user.permissions ?? 0)))),
    },
    {
      text: intl.formatMessage(messages.menuSiri),
      route: '/settings/siri',
      regex: /\/settings\/siri/,
      // Your own, while Siri reports are on and you may report problems.
      // Someone who manages users sees another person's, to revoke its key,
      // except the owner's or another admin's.
      hidden:
        currentUser?.id === user.id
          ? !siriOn ||
            !hasPermission(
              [Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES],
              user.permissions ?? 0,
              { type: 'or' }
            )
          : !hasPermission(
              Permission.MANAGE_USERS,
              currentUser?.permissions ?? 0
            ) ||
            (currentUser?.id !== 1 &&
              (user.id === 1 ||
                hasPermission(Permission.ADMIN, user.permissions ?? 0))),
    },
    {
      text: intl.formatMessage(messages.menuNotifications),
      route: data?.emailEnabled
        ? '/settings/notifications/email'
        : data?.webPushEnabled
          ? '/settings/notifications/webpush'
          : data?.discordEnabled
            ? '/settings/notifications/discord'
            : '/settings/notifications/pushbullet',
      regex: /\/settings\/notifications/,
    },
    {
      text: intl.formatMessage(messages.menuPermissions),
      route: '/settings/permissions',
      regex: /\/settings\/permissions/,
      requiredPermission: Permission.MANAGE_USERS,
      hidden: currentUser?.id !== 1 && currentUser?.id === user.id,
    },
  ];

  if (currentUser?.id !== 1 && user.id === 1) {
    return (
      <>
        <PageTitle
          title={[
            intl.formatMessage(globalMessages.usersettings),
            user.displayName,
          ]}
        />
        <ProfileHeader user={user} isSettingsPage />
        <div className="mt-6">
          <Alert
            title={intl.formatMessage(messages.unauthorizedDescription)}
            type="error"
          />
        </div>
      </>
    );
  }

  settingsRoutes.forEach((settingsRoute) => {
    settingsRoute.route = router.asPath.includes('/profile')
      ? `/profile${settingsRoute.route}`
      : `/users/${user.id}${settingsRoute.route}`;
  });

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(globalMessages.usersettings),
          user.displayName,
        ]}
      />
      <ProfileHeader user={user} isSettingsPage />
      <div className="mt-6">
        <SettingsTabs settingsRoutes={settingsRoutes} />
      </div>
      <div className="mt-10 text-strong" data-seerr="settings">
        {children}
      </div>
    </>
  );
};

export default UserSettings;
