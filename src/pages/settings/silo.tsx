import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsSilo from '@app/components/Settings/SettingsSilo';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SiloSettingsPage: NextPage = () => {
  useRouteGuard(Permission.MANAGE_SETTINGS);
  return (
    <SettingsLayout>
      <SettingsSilo />
    </SettingsLayout>
  );
};

export default SiloSettingsPage;
