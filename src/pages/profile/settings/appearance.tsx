import UserSettings from '@app/components/UserProfile/UserSettings';
import UserAppearanceSettings from '@app/components/UserProfile/UserSettings/UserAppearanceSettings';
import type { NextPage } from 'next';

const UserSettingsAppearancePage: NextPage = () => {
  return (
    <UserSettings>
      <UserAppearanceSettings />
    </UserSettings>
  );
};

export default UserSettingsAppearancePage;
