import AgentList from '@app/components/Backfill/Agent';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const BackfillAgentPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return <AgentList />;
};

export default BackfillAgentPage;
