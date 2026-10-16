import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsMusicTab from '@app/components/Settings/SettingsMusicTab';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsMusicPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsMusicTab />
    </SettingsLayout>
  );
};

export default SettingsMusicPage;
