import RunDetail from '@app/components/Backfill/Agent/RunDetail';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const BackfillAgentRunPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return <RunDetail />;
};

export default BackfillAgentRunPage;
