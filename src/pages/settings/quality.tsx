import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsQuality from '@app/components/Settings/SettingsQuality';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsQualityPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsQuality />
    </SettingsLayout>
  );
};

export default SettingsQualityPage;
