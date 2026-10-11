import BackfillDashboard from '@app/components/Backfill/Dashboard';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const BackfillPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return <BackfillDashboard />;
};

export default BackfillPage;
