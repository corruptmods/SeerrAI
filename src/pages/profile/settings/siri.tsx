import UserSettings from '@app/components/UserProfile/UserSettings';
import UserSiriSettings from '@app/components/UserProfile/UserSettings/UserSiriSettings';
import type { NextPage } from 'next';

// Siri's "Fix this show" shortcut: adding it, and the key it uses.
const UserSiriPage: NextPage = () => {
  return (
    <UserSettings>
      <UserSiriSettings />
    </UserSettings>
  );
};

export default UserSiriPage;
