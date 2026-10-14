import PageTitle from '@app/components/Common/PageTitle';
import type { SettingsRoute } from '@app/components/Common/SettingsTabs';
import SettingsTabs from '@app/components/Common/SettingsTabs';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings', {
  menuGeneralSettings: 'General',
  menuUsers: 'Users',
  menuFeatures: 'Features',
  menuMediaServers: 'Media Servers',
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
    // Each server's own settings (/settings/plex, /settings/jellyfin,
    // /settings/emby) are reached from here, with Edit.
    {
      text: intl.formatMessage(messages.menuMediaServers),
      route: '/settings/media-servers',
      regex: /^\/settings\/(media-servers|plex|jellyfin|emby)/,
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
};

export default SettingsLayout;
