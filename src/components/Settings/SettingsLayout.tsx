import PageTitle from '@app/components/Common/PageTitle';
import type { SettingsRoute } from '@app/components/Common/SettingsTabs';
import SettingsTabs from '@app/components/Common/SettingsTabs';
import useSettings from '@app/hooks/useSettings';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { MediaServerType } from '@server/constants/server';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings', {
  menuGeneralSettings: 'General',
  menuUsers: 'Users',
  menuFeatures: 'Features',
  menuPlexSettings: 'Plex',
  menuJellyfinSettings: '{mediaServerName}',
  menuServices: 'Services',
  menuNetwork: 'Network',
  menuNotifications: 'Notifications',
  menuLogs: 'Logs',
  menuJobs: 'Jobs & Cache',
  menuHealth: 'Health',
  menuAbout: 'About',
  menuMetadataProviders: 'Metadata Providers',
  menuAi: 'AI',
  menuBackfill: 'Backfill',
  menuGuide: 'How It Works',
});

type SettingsLayoutProps = {
  children: React.ReactNode;
};

const SettingsLayout = ({ children }: SettingsLayoutProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const settingsRoutes: SettingsRoute[] = [
    {
      text: intl.formatMessage(messages.menuGeneralSettings),
      route: '/settings/main',
      regex: /^\/settings(\/main)?$/,
    },
    {
      text: intl.formatMessage(messages.menuUsers),
      route: '/settings/users',
      regex: /^\/settings\/users/,
    },
    {
      text: intl.formatMessage(messages.menuFeatures),
      route: '/settings/features',
      regex: /^\/settings\/features/,
    },
    settings.currentSettings.mediaServerType === MediaServerType.PLEX
      ? {
          text: intl.formatMessage(messages.menuPlexSettings),
          route: '/settings/plex',
          regex: /^\/settings\/plex/,
        }
      : {
          text: getAvailableMediaServerName(),
          route: '/settings/jellyfin',
          regex: /^\/settings\/jellyfin/,
        },
    {
      text: intl.formatMessage(messages.menuServices),
      route: '/settings/services',
      regex: /^\/settings\/services/,
    },
    {
      text: intl.formatMessage(messages.menuNetwork),
      route: '/settings/network',
      regex: /^\/settings\/network/,
    },
    {
      text: intl.formatMessage(messages.menuMetadataProviders),
      route: '/settings/metadata',
      regex: /^\/settings\/metadata/,
    },
    {
      text: intl.formatMessage(messages.menuAi),
      route: '/settings/ai',
      regex: /^\/settings\/ai/,
    },
    {
      text: intl.formatMessage(messages.menuBackfill),
      route: '/settings/backfill',
      regex: /^\/settings\/backfill/,
    },
    {
      text: intl.formatMessage(messages.menuNotifications),
      route: '/settings/notifications/email',
      regex: /^\/settings\/notifications/,
    },
    {
      text: intl.formatMessage(messages.menuLogs),
      route: '/settings/logs',
      regex: /^\/settings\/logs/,
    },
    {
      text: intl.formatMessage(messages.menuJobs),
      route: '/settings/jobs',
      regex: /^\/settings\/jobs/,
    },
    {
      text: intl.formatMessage(messages.menuHealth),
      route: '/settings/health',
      regex: /^\/settings\/health/,
    },
    {
      text: intl.formatMessage(messages.menuGuide),
      route: '/settings/guide',
      regex: /^\/settings\/guide/,
    },
    {
      text: intl.formatMessage(messages.menuAbout),
      route: '/settings/about',
      regex: /^\/settings\/about/,
    },
  ];

  return (
    <>
      <PageTitle title={intl.formatMessage(globalMessages.settings)} />
      <div className="mt-6">
        <SettingsTabs settingsRoutes={settingsRoutes} />
      </div>
      <div className="mt-10 text-white">{children}</div>
    </>
  );
  function getAvailableMediaServerName() {
    return intl.formatMessage(messages.menuJellyfinSettings, {
      mediaServerName:
        settings.currentSettings.mediaServerType === MediaServerType.JELLYFIN
          ? 'Jellyfin'
          : settings.currentSettings.mediaServerType === MediaServerType.EMBY
            ? 'Emby'
            : undefined,
    });
  }
};

export default SettingsLayout;
