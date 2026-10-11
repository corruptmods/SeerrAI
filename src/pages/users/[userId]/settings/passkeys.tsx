import UserSettings from '@app/components/UserProfile/UserSettings';
import UserPasskeySettings from '@app/components/UserProfile/UserSettings/UserPasskeySettings';
import type { NextPage } from 'next';

// Your own passkeys, or, for someone who manages users, another person's,
// to remove one for a lost device.
const UserPasskeysPage: NextPage = () => {
  return (
    <UserSettings>
      <UserPasskeySettings />
    </UserSettings>
  );
};

export default UserPasskeysPage;
