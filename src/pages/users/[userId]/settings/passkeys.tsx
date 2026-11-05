import UserSettings from '@app/components/UserProfile/UserSettings';
import UserPasskeySettings from '@app/components/UserProfile/UserSettings/UserPasskeySettings';
import type { NextPage } from 'next';

// Own passkeys, or another user's for user managers (to remove a lost device's).
const UserPasskeysPage: NextPage = () => {
  return (
    <UserSettings>
      <UserPasskeySettings />
    </UserSettings>
  );
};

export default UserPasskeysPage;
