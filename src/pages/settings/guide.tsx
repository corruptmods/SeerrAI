import SettingsGuide from '@app/components/Settings/SettingsGuide';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsGuidePage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsGuide />
    </SettingsLayout>
  );
};

export default SettingsGuidePage;
