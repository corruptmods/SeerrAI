import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsMediaServers from '@app/components/Settings/SettingsMediaServers';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const MediaServersSettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsMediaServers />
    </SettingsLayout>
  );
};

export default MediaServersSettingsPage;
