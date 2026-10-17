import SettingsAppearance from '@app/components/Settings/SettingsAppearance';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsAppearancePage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsAppearance />
    </SettingsLayout>
  );
};

export default SettingsAppearancePage;
