import SettingsHealth from '@app/components/Settings/SettingsHealth';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsHealthPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsHealth />
    </SettingsLayout>
  );
};

export default SettingsHealthPage;
