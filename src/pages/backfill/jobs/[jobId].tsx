import JobDetail from '@app/components/Backfill/JobDetail';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const BackfillJobPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return <JobDetail />;
};

export default BackfillJobPage;
