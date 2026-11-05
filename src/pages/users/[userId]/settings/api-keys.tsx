import UserSettings from '@app/components/UserProfile/UserSettings';
import UserApiKeySettings from '@app/components/UserProfile/UserSettings/UserApiKeySettings';
import type { NextPage } from 'next';

// Own API keys, or another user's for user managers (to review and revoke).
const UserApiKeysPage: NextPage = () => {
  return (
    <UserSettings>
      <UserApiKeySettings />
    </UserSettings>
  );
};

export default UserApiKeysPage;
