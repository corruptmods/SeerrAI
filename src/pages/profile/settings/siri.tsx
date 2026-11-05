import UserSettings from '@app/components/UserProfile/UserSettings';
import UserSiriSettings from '@app/components/UserProfile/UserSettings/UserSiriSettings';
import type { NextPage } from 'next';

// Setup for Siri's "Fix this show" shortcut and its key.
const UserSiriPage: NextPage = () => {
  return (
    <UserSettings>
      <UserSiriSettings />
    </UserSettings>
  );
};

export default UserSiriPage;
