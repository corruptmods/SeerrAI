import UserSettings from '@app/components/UserProfile/UserSettings';
import UserApiKeySettings from '@app/components/UserProfile/UserSettings/UserApiKeySettings';
import type { NextPage } from 'next';

// Your own API keys, or, for someone who manages users, another person's,
// to see which apps can act as them and revoke one.
const UserApiKeysPage: NextPage = () => {
  return (
    <UserSettings>
      <UserApiKeySettings />
    </UserSettings>
  );
};

export default UserApiKeysPage;
