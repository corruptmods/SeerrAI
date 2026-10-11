import SettingsBackfill from '@app/components/Settings/SettingsBackfill';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsBackfillPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsBackfill />
    </SettingsLayout>
  );
};

export default SettingsBackfillPage;
