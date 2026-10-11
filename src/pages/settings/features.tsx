import SettingsFeatures from '@app/components/Settings/SettingsFeatures';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsFeaturesPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsFeatures />
    </SettingsLayout>
  );
};

export default SettingsFeaturesPage;
