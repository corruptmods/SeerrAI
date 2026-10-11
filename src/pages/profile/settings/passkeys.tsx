import UserSettings from '@app/components/UserProfile/UserSettings';
import UserPasskeySettings from '@app/components/UserProfile/UserSettings/UserPasskeySettings';
import type { NextPage } from 'next';

const UserSettingsPasskeysPage: NextPage = () => {
  return (
    <UserSettings>
      <UserPasskeySettings />
    </UserSettings>
  );
};

export default UserSettingsPasskeysPage;
