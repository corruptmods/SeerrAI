import UserSettings from '@app/components/UserProfile/UserSettings';
import UserFeatureSettings from '@app/components/UserProfile/UserSettings/UserFeatureSettings';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const UserFeaturesPage: NextPage = () => {
  useRouteGuard(Permission.MANAGE_USERS);
  return (
    <UserSettings>
      <UserFeatureSettings />
    </UserSettings>
  );
};

export default UserFeaturesPage;
