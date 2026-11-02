import UserSettings from '@app/components/UserProfile/UserSettings';
import UserLibrarySettings from '@app/components/UserProfile/UserSettings/UserLibrarySettings';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const UserLibrariesPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <UserSettings>
      <UserLibrarySettings />
    </UserSettings>
  );
};

export default UserLibrariesPage;
