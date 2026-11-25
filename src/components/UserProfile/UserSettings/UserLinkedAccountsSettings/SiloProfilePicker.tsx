import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

/*
 * "My profile" under a linked Silo account: which household profile on the
 * account is this person's. All profiles counts the whole account.
 */

const messages = defineMessages(
  'components.UserProfile.UserSettings.SiloProfilePicker',
  {
    myProfile: 'My profile',
    allProfiles: 'All profiles',
    child: '{name} (child)',
    saved: 'Your Silo profile was saved.',
    failed: 'Your Silo profile could not be saved.',
    unreadable: 'Silo’s profiles could not be read.',
  }
);

interface SiloProfiles {
  profileId: string | null;
  profiles: { id: string; name: string; primary: boolean; child: boolean }[];
}

const SiloProfilePicker = ({ userId }: { userId: number }) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [saving, setSaving] = useState(false);
  const endpoint = `/api/v1/user/${userId}/settings/linked-accounts/silo`;
  const { data, error, mutate } = useSWR<SiloProfiles>(`${endpoint}/profiles`);

  if (error) {
    return (
      <div className="mt-2 text-sm text-gray-400">
        {intl.formatMessage(messages.unreadable)}
      </div>
    );
  }
  if (!data) return null;

  const choose = async (profileId: string | null) => {
    setSaving(true);
    try {
      await axios.put(`${endpoint}/profile`, { profileId });
      await mutate({ ...data, profileId }, { revalidate: false });
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.failed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <label
        htmlFor="silo-profile"
        className="text-sm font-medium text-gray-300"
      >
        {intl.formatMessage(messages.myProfile)}
      </label>
      <select
        id="silo-profile"
        className="short"
        value={data.profileId ?? ''}
        disabled={saving}
        onChange={(e) => choose(e.target.value || null)}
      >
        <option value="">{intl.formatMessage(messages.allProfiles)}</option>
        {data.profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.child
              ? intl.formatMessage(messages.child, { name: profile.name })
              : profile.name}
          </option>
        ))}
      </select>
    </div>
  );
};

export default SiloProfilePicker;
