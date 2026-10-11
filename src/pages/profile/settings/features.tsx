import UserSettings from '@app/components/UserProfile/UserSettings';
import UserFeatureSettings from '@app/components/UserProfile/UserSettings/UserFeatureSettings';
import type { NextPage } from 'next';

const UserSettingsFeaturesPage: NextPage = () => {
  return (
    <UserSettings>
      <UserFeatureSettings />
    </UserSettings>
  );
};

export default UserSettingsFeaturesPage;
